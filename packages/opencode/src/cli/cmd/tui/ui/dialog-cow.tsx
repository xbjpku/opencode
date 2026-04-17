import { ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useDialog, type DialogContext } from "./dialog"
import { createStore } from "solid-js/store"
import { createMemo, For, Show } from "solid-js"
import { useKeyboard, useTerminalDimensions, useRenderer } from "@opentui/solid"
import type { z } from "zod"
import type { CowEntrySchema } from "../event"
import { commitCowGen, discardCow, log } from "@/tool/bash"
import { createTwoFilesPatch } from "diff"
import fs from "fs"
import path from "path"
import { LANGUAGE_EXTENSIONS } from "@/lsp/language"
import { Selection } from "@tui/util/selection"
import { useToast } from "./toast"

type CowEntry = z.infer<typeof CowEntrySchema>

type CowGroup = {
  generation: number
  command: string
  entries: CowEntry[]
}

export type DialogCowProps = {
  sessionID: string
  entries: CowEntry[]
  deleted: string[]
  onDone?: () => void
}

function filetype(input?: string) {
  if (!input) return "none"
  const ext = path.extname(input)
  const language = LANGUAGE_EXTENSIONS[ext]
  if (["typescriptreact", "javascriptreact", "javascript"].includes(language)) return "typescript"
  return language ?? "none"
}

function readFileOr(p: string, fallback: string): string {
  try { return fs.readFileSync(p, "utf-8") } catch { return fallback }
}

export function DialogCowCommit(props: DialogCowProps) {
  const dialog = useDialog()
  const themeState = useTheme()
  const { theme } = themeState
  const dimensions = useTerminalDimensions()
  const renderer = useRenderer()
  const toast = useToast()

  const [store, setStore] = createStore({
    cmdCursor: 0,
    level: "cmd" as "cmd" | "file",
    fileCursor: 0,
  })

  dialog.setSize("large")

  function entryHasDiff(entry: CowEntry, allGroups: CowGroup[]): boolean {
    const gen = entry.generation ?? 0
    let prevCowPath: string | null = null
    for (const g of allGroups) {
      if (g.generation >= gen) break
      for (const e of g.entries) {
        if (e.orig_path === entry.orig_path) prevCowPath = e.cow_path
      }
    }
    const origPath = prevCowPath ?? entry.orig_path
    // Check content difference
    const oldContent = readFileOr(origPath, "")
    const newContent = readFileOr(entry.cow_path, "")
    if (oldContent !== newContent) return true
    // Check permission/metadata difference (chmod-only changes)
    try {
      const oldStat = fs.statSync(origPath)
      const newStat = fs.statSync(entry.cow_path)
      if (oldStat.mode !== newStat.mode) return true
    } catch {}
    return false
  }

  const groups = createMemo<CowGroup[]>(() => {
    const map = new Map<number, CowGroup>()
    for (const e of props.entries) {
      const gen = e.generation ?? 0
      if (!map.has(gen))
        map.set(gen, { generation: gen, command: e.command || "(unknown)", entries: [] })
      map.get(gen)!.entries.push(e)
    }
    const allGroups = Array.from(map.values()).sort((a, b) => a.generation - b.generation)
    return allGroups
      .map((g) => ({ ...g, entries: g.entries.filter((e) => entryHasDiff(e, allGroups)) }))
      .filter((g) => g.entries.length > 0)
  })

  const groupCount = () => groups().length

  function cleanCommand(cmd: string): string {
    return cmd
      .replace(/^\/bin\/bash\s+-c\s+/, "")
      .replace(/^\/bin\/sh\s+-c\s+/, "")
      .replace(/^bash\s+-c\s+/, "")
      .replace(/^sh\s+-c\s+/, "")
  }

  const listHeight = createMemo(() =>
    Math.floor(dimensions().height * 3 / 4) - 8
  )

  const diffView = createMemo(() =>
    dimensions().width > 120 ? "split" as const : "unified" as const
  )

  let scroll: ScrollBoxRenderable | undefined

  function scrollToId(id: string) {
    if (!scroll) return
    function find(parent: { getChildren(): { id?: string; y: number; getChildren(): any[] }[] }): { y: number } | null {
      for (const child of parent.getChildren()) {
        if (child.id === id) return child
        const found = find(child)
        if (found) return found
      }
      return null
    }
    const target = find(scroll)
    if (!target) return
    const y = target.y - scroll.y
    if (y >= scroll.height) scroll.scrollBy(y - scroll.height + 1)
    if (y < 0) scroll.scrollBy(y)
  }

  function makeDiffForEntry(entry: CowEntry): string {
    const gen = entry.generation ?? 0
    let prevCowPath: string | null = null
    for (const g of groups()) {
      if (g.generation >= gen) break
      for (const e of g.entries) {
        if (e.orig_path === entry.orig_path) prevCowPath = e.cow_path
      }
    }
    const origPath = prevCowPath ?? entry.orig_path
    const oldContent = readFileOr(origPath, "")
    const newContent = readFileOr(entry.cow_path, "")
    if (oldContent !== newContent) {
      return createTwoFilesPatch(entry.orig_path, entry.orig_path, oldContent, newContent)
    }
    // Content identical — check for permission change
    try {
      const oldMode = (fs.statSync(origPath).mode & 0o7777).toString(8)
      const newMode = (fs.statSync(entry.cow_path).mode & 0o7777).toString(8)
      if (oldMode !== newMode) {
        return `--- ${entry.orig_path}\n+++ ${entry.orig_path}\n@@ permissions @@\n-mode: ${oldMode}\n+mode: ${newMode}\n`
      }
    } catch {}
    return ""
  }

  // The "active" diff key: in file mode, always show diff for current file
  const activeDiffKey = createMemo(() => {
    if (store.level !== "file") return ""
    const g = groups()[store.cmdCursor]
    if (!g) return ""
    const entry = g.entries[store.fileCursor]
    if (!entry) return ""
    return `${entry.generation}:${entry.orig_path}`
  })

  function commitPrefix() {
    const g = groups()
    if (g.length === 0) return
    const maxGen = g[store.cmdCursor].generation
    const result = commitCowGen(props.sessionID, maxGen)
    if (!result.ok) log.error("cow commitCowGen failed", { error: result.error, maxGen })
    if (store.cmdCursor >= g.length - 1) {
      const discard = discardCow(props.sessionID)
      if (!discard.ok) log.error("cow discard failed", { sessionID: props.sessionID })
    }
    props.onDone?.()
    dialog.clear()
  }

  // Enter file level for a group, optionally at a specific file index
  function enterFileLevel(fileIdx: number) {
    const g = groups()[store.cmdCursor]
    if (!g || g.entries.length === 0) return
    setStore("level", "file")
    setStore("fileCursor", Math.min(fileIdx, g.entries.length - 1))
    scrollToId(`cow-file-${store.cmdCursor}-${store.fileCursor}`)
  }

  useKeyboard((evt) => {
    // === CMD level ===
    if (store.level === "cmd") {
      if (evt.name === "up" || evt.name === "k") {
        evt.preventDefault()
        evt.stopPropagation()
        setStore("cmdCursor", Math.max(0, store.cmdCursor - 1))
        scrollToId(`cow-cmd-${store.cmdCursor}`)
        return
      }
      if (evt.name === "down" || evt.name === "j") {
        evt.preventDefault()
        evt.stopPropagation()
        setStore("cmdCursor", Math.min(groupCount() - 1, store.cmdCursor + 1))
        scrollToId(`cow-cmd-${store.cmdCursor}`)
        return
      }
      if (evt.name === "space" || evt.name === "right" || evt.name === "l") {
        evt.preventDefault()
        evt.stopPropagation()
        enterFileLevel(0)
        return
      }
      if (evt.name === "return") {
        evt.preventDefault()
        evt.stopPropagation()
        commitPrefix()
        return
      }
      if (evt.name === "d") {
        evt.preventDefault()
        evt.stopPropagation()
        const result = discardCow(props.sessionID)
        if (!result.ok) log.error("cow discard failed", { sessionID: props.sessionID })
        props.onDone?.()
        dialog.clear()
        return
      }
      return
    }

    // === FILE level ===
    if (store.level === "file") {
      const g = groups()[store.cmdCursor]
      if (!g) return

      if (evt.name === "up" || evt.name === "k") {
        evt.preventDefault()
        evt.stopPropagation()
        if (store.fileCursor > 0) {
          setStore("fileCursor", store.fileCursor - 1)
          scrollToId(`cow-file-${store.cmdCursor}-${store.fileCursor}`)
        } else {
          // At first file — go back to this cmd's header
          setStore("level", "cmd")
          scrollToId(`cow-cmd-${store.cmdCursor}`)
        }
        return
      }
      if (evt.name === "down" || evt.name === "j") {
        evt.preventDefault()
        evt.stopPropagation()
        if (store.fileCursor < g.entries.length - 1) {
          setStore("fileCursor", store.fileCursor + 1)
          scrollToId(`cow-file-${store.cmdCursor}-${store.fileCursor}`)
        } else if (store.cmdCursor < groupCount() - 1) {
          // At last file — move to next cmd (cmd level)
          setStore("cmdCursor", store.cmdCursor + 1)
          setStore("level", "cmd")
          scrollToId(`cow-cmd-${store.cmdCursor}`)
        }
        return
      }
      // escape / left = back to cmd level
      if (evt.name === "escape" || evt.name === "left" || evt.name === "h") {
        evt.preventDefault()
        evt.stopPropagation()
        setStore("level", "cmd")
        scrollToId(`cow-cmd-${store.cmdCursor}`)
        return
      }
      // enter at file level = back to cmd level
      if (evt.name === "return") {
        evt.preventDefault()
        evt.stopPropagation()
        setStore("level", "cmd")
        scrollToId(`cow-cmd-${store.cmdCursor}`)
        return
      }
      return
    }
  })

  const selectedCount = () => {
    const g = groups()
    let n = 0
    for (let i = 0; i <= store.cmdCursor && i < g.length; i++) n += g[i].entries.length
    return n
  }

  const helpText = () =>
    store.level === "cmd"
      ? "↑↓:select  space:files  enter:commit  d:discard  esc:commit all"
      : "↑↓:navigate files  esc/←:back to commands"

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          COW — commit first {store.cmdCursor + 1}/{groupCount()} commands ({selectedCount()} files)
        </text>
        <text fg={theme.textMuted}>esc:all</text>
      </box>

      <scrollbox
        ref={(r: ScrollBoxRenderable) => (scroll = r)}
        maxHeight={listHeight()}
        scrollbarOptions={{ visible: false }}
        onMouseUp={() => Selection.copy(renderer, toast)}
      >
        <For each={groups()}>
          {(group, groupIdx) => {
            const isIncluded = () => groupIdx() <= store.cmdCursor
            const isCmdCursor = () => store.level === "cmd" && groupIdx() === store.cmdCursor
            const isActiveGroup = () => groupIdx() === store.cmdCursor
            return (
              <box gap={0}>
                <box flexDirection="row" id={`cow-cmd-${groupIdx()}`}>
                  <text fg={isIncluded() ? theme.success : theme.textMuted}>
                    {isIncluded() ? "[x] " : "[ ] "}
                  </text>
                  <text
                    fg={isCmdCursor() ? theme.primary : isIncluded() ? theme.text : theme.textMuted}
                    attributes={isCmdCursor() ? TextAttributes.BOLD : TextAttributes.DIM}
                  >
                    $ {(() => { const c = cleanCommand(group.command); return c.length > 76 ? c.slice(0, 73) + "..." : c })()}
                  </text>
                </box>
                <For each={group.entries}>
                  {(entry, fileIdx) => {
                    const isFileCursor = () =>
                      store.level === "file" && isActiveGroup() && fileIdx() === store.fileCursor
                    const diffKey = () => `${entry.generation}:${entry.orig_path}`
                    // Show diff automatically when this file is the active cursor in file mode
                    const showDiff = () => activeDiffKey() === diffKey()
                    return (
                      <box paddingLeft={4} id={`cow-file-${groupIdx()}-${fileIdx()}`}>
                        <box flexDirection="row">
                          <Show when={store.level === "file" && isActiveGroup()}>
                            <text fg={isFileCursor() ? theme.primary : theme.textMuted}>
                              {isFileCursor() ? "▸ " : "  "}
                            </text>
                          </Show>
                          <text
                            fg={isFileCursor() ? theme.primary : isIncluded() ? theme.text : theme.textMuted}
                            attributes={isFileCursor() ? TextAttributes.BOLD : 0}
                          >
                            {entry.orig_path}
                          </text>
                          <text fg={theme.accent}> {entry.operation}</text>
                        </box>
                        <Show when={showDiff()}>
                          <box paddingTop={1} paddingBottom={1}>
                            <diff
                              diff={makeDiffForEntry(entry)}
                              view={diffView()}
                              filetype={filetype(entry.orig_path)}
                              syntaxStyle={themeState.syntax()}
                              showLineNumbers={true}
                              width="100%"
                              wrapMode="word"
                              fg={theme.text}
                              addedBg={theme.diffAddedBg}
                              removedBg={theme.diffRemovedBg}
                              contextBg={theme.diffContextBg}
                              addedSignColor={theme.diffHighlightAdded}
                              removedSignColor={theme.diffHighlightRemoved}
                              lineNumberFg={theme.diffLineNumber}
                              lineNumberBg={theme.diffContextBg}
                              addedLineNumberBg={theme.diffAddedLineNumberBg}
                              removedLineNumberBg={theme.diffRemovedLineNumberBg}
                            />
                          </box>
                        </Show>
                      </box>
                    )
                  }}
                </For>
              </box>
            )
          }}
        </For>
      </scrollbox>

      <box flexDirection="row" gap={2} paddingTop={1} paddingBottom={1}>
        <text fg={theme.textMuted}>
          {helpText()}
        </text>
      </box>
    </box>
  )
}

DialogCowCommit.show = (
  dialog: DialogContext,
  sessionID: string,
  entries: CowEntry[],
  deleted: string[],
) => {
  // Check if any entry has actual changes (content or permissions).
  // If not, auto-commit silently — no need to show an empty dialog.
  const hasAnyChange = entries.some((entry) => {
    const gen = entry.generation ?? 0
    let prevCowPath: string | null = null
    for (const other of entries) {
      if (other.orig_path === entry.orig_path && (other.generation ?? 0) < gen) {
        if (!prevCowPath || (other.generation ?? 0) > (entries.find((e) => e.cow_path === prevCowPath)?.generation ?? -1)) {
          prevCowPath = other.cow_path
        }
      }
    }
    const origPath = prevCowPath ?? entry.orig_path
    const oldContent = readFileOr(origPath, "")
    const newContent = readFileOr(entry.cow_path, "")
    if (oldContent !== newContent) return true
    try {
      const oldMode = fs.statSync(origPath).mode
      const newMode = fs.statSync(entry.cow_path).mode
      if (oldMode !== newMode) return true
    } catch {}
    return false
  })

  if (!hasAnyChange) {
    // No actual changes — commit all silently
    const maxGen = entries.reduce((max, e) => Math.max(max, e.generation ?? 0), 0)
    commitCowGen(sessionID, maxGen)
    discardCow(sessionID)
    return Promise.resolve()
  }

  let done = false
  return new Promise<void>((resolve) => {
    dialog.replace(
      () => (
        <DialogCowCommit
          sessionID={sessionID}
          entries={entries}
          deleted={deleted}
          onDone={() => {
            done = true
            resolve()
          }}
        />
      ),
      () => {
        if (!done) {
          const g = entries.reduce((max, e) => Math.max(max, e.generation ?? 0), 0)
          const result = commitCowGen(sessionID, g)
          if (!result.ok) log.error("cow commit-all failed on escape", { error: result.error })
          const discard = discardCow(sessionID)
          if (!discard.ok) log.error("cow discard failed on escape", { sessionID })
        }
        resolve()
      },
    )
  })
}
