import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useDialog, type DialogContext } from "./dialog"
import { createStore } from "solid-js/store"
import { For } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import type { z } from "zod"
import type { CowEntrySchema } from "../event"
import { commitCow, discardCow, log } from "@/tool/bash"

type CowEntry = z.infer<typeof CowEntrySchema>

export type DialogCowProps = {
  sessionID: string
  entries: CowEntry[]
  deleted: string[]
  onDone?: () => void
}

export function DialogCowCommit(props: DialogCowProps) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const [store, setStore] = createStore({
    selected: new Set<string>() as Set<string>,
    cursor: 0,
  })

  // Group entries by command
  const groups = () => {
    const map = new Map<string, CowEntry[]>()
    for (const e of props.entries) {
      const key = e.command || "(unknown)"
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(e)
    }
    return Array.from(map.entries())
  }

  const allPaths = () => props.entries.map((e) => e.orig_path)
  const totalCount = () => props.entries.length

  useKeyboard((evt) => {
    // Navigation
    if (evt.name === "up" || evt.name === "k") {
      evt.preventDefault()
      evt.stopPropagation()
      setStore("cursor", Math.max(0, store.cursor - 1))
      return
    }
    if (evt.name === "down" || evt.name === "j") {
      evt.preventDefault()
      evt.stopPropagation()
      setStore("cursor", Math.min(totalCount() - 1, store.cursor + 1))
      return
    }

    // Toggle selection
    if (evt.name === "space") {
      evt.preventDefault()
      evt.stopPropagation()
      const path = allPaths()[store.cursor]
      if (path) {
        const next = new Set(store.selected)
        if (next.has(path)) next.delete(path)
        else next.add(path)
        setStore("selected", next)
      }
      return
    }

    // Select all / deselect all
    if (evt.name === "a") {
      evt.preventDefault()
      evt.stopPropagation()
      if (store.selected.size === totalCount()) {
        setStore("selected", new Set())
      } else {
        setStore("selected", new Set(allPaths()))
      }
      return
    }

    // Enter = commit selected immediately
    if (evt.name === "return") {
      evt.preventDefault()
      evt.stopPropagation()
      if (store.selected.size > 0) {
        const paths = Array.from(store.selected)
        const result = commitCow(props.sessionID, paths)
        if (!result.ok) {
          log.error("cow commit failed", { error: result.error, paths })
        }
        const discard = discardCow(props.sessionID)
        if (!discard.ok) {
          log.error("cow discard failed after commit", { sessionID: props.sessionID })
        }
        props.onDone?.()
        dialog.clear()
      }
      return
    }

    // d = discard all immediately
    if (evt.name === "d") {
      evt.preventDefault()
      evt.stopPropagation()
      const result = discardCow(props.sessionID)
      if (!result.ok) {
        log.error("cow discard failed", { sessionID: props.sessionID })
      }
      props.onDone?.()
      dialog.clear()
      return
    }

    // Escape is handled by the dialog system's onClose callback
    // (dialog system handler fires before this one and calls stopPropagation,
    // so this handler would never see escape anyway)
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          COW Changes ({totalCount()} files)
        </text>
        <text fg={theme.textMuted}>esc to commit all</text>
      </box>

      <box>
          <For each={groups()}>
            {([cmd, entries]) => (
              <box gap={0}>
                <text fg={theme.textMuted} attributes={TextAttributes.DIM}>
                  $ {cmd.length > 60 ? cmd.slice(0, 57) + "..." : cmd}
                </text>
                <For each={entries}>
                  {(entry) => {
                    const idx = () => allPaths().indexOf(entry.orig_path)
                    const isCursor = () => idx() === store.cursor
                    const isSelected = () => store.selected.has(entry.orig_path)
                    return (
                      <box flexDirection="row">
                        <text fg={isSelected() ? theme.success : theme.textMuted}>
                          {isSelected() ? "[x] " : "[ ] "}
                        </text>
                        <text
                          fg={isCursor() ? theme.primary : theme.text}
                          attributes={isCursor() ? TextAttributes.BOLD : 0}
                        >
                          {entry.orig_path}
                        </text>
                        <text fg={theme.textMuted}> ({entry.operation})</text>
                      </box>
                    )
                  }}
                </For>
              </box>
            )}
          </For>
      </box>
      <box flexDirection="row" gap={2} paddingTop={1} paddingBottom={1}>
        <text fg={theme.textMuted}>
          space:toggle  a:all  enter:commit selected  d:discard all  esc:commit all
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
        // onClose: called by the dialog system when escape/ctrl+c is pressed.
        // The dialog system handler fires before the cow dialog's useKeyboard
        // handler (registered earlier) and calls stopPropagation, so the cow
        // dialog never sees escape. We handle "escape = commit all" here.
        if (!done) {
          const all = entries.map((e) => e.orig_path)
          if (all.length > 0) {
            const result = commitCow(sessionID, all)
            if (!result.ok) {
              log.error("cow commit-all failed on escape", { error: result.error })
            }
          }
          const discard = discardCow(sessionID)
          if (!discard.ok) {
            log.error("cow discard failed on escape", { sessionID })
          }
        }
        resolve()
      },
    )
  })
}
