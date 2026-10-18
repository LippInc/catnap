import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "../index"

// Fake OpenCode client: records every call in order, so the tests can check the order and the arguments.
type Call = { name: string; args: any }
const WINDOW = 10_000 // plugin option `window`: 1% = 100 tokens
const SID = "ses_test"

let logDir = ""
const savedEnv: Record<string, string | undefined> = {}
const ENV_KEYS = [
  "COMPACT_WHEN_READY_LOG_DIR",
  "COMPACT_WHEN_READY_OFF",
  "COMPACT_WHEN_READY_SOFT",
  "COMPACT_WHEN_READY_STRICT",
  "COMPACT_WHEN_READY_WINDOW",
]

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
  logDir = mkdtempSync(join(tmpdir(), "cwr-oc-unit-"))
  process.env.COMPACT_WHEN_READY_LOG_DIR = logDir
})
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  rmSync(logDir, { recursive: true, force: true })
})

type Fake = {
  summarize?: (args: any) => any
  promptAsync?: (args: any) => any
  providers?: () => any
  get?: (args: any) => any
}

const make = async (options: Record<string, unknown> = { window: WINDOW }, fake: Fake = {}) => {
  const calls: Call[] = []
  const client: any = {
    config: {
      providers: async () => {
        calls.push({ name: "providers", args: {} })
        return fake.providers ? fake.providers() : { data: { providers: [] } }
      },
    },
    session: {
      summarize: async (args: any) => {
        calls.push({ name: "summarize", args })
        return fake.summarize ? fake.summarize(args) : { data: true }
      },
      promptAsync: async (args: any) => {
        calls.push({ name: "promptAsync", args })
        return fake.promptAsync ? fake.promptAsync(args) : { data: undefined }
      },
      get: async (args: any) => {
        calls.push({ name: "get", args })
        return fake.get ? fake.get(args) : { data: { id: args.path.id } }
      },
    },
    tui: {
      showToast: async (args: any) => {
        calls.push({ name: "toast", args })
        return { data: true }
      },
    },
  }
  const hooks: any = await plugin.server({ client } as any, options)
  let created = 1000
  let n = 0
  return {
    hooks,
    calls,
    names: () => calls.map((c) => c.name),
    // an assistant message whose context is `tokens` (all in input), i.e. tokens / WINDOW * 100 percent
    async assistant(tokens: number, extra: Record<string, unknown> = {}) {
      created += 10
      n += 1
      await hooks.event({
        event: {
          type: "message.updated",
          properties: {
            info: {
              id: `msg_${n}`,
              sessionID: SID,
              role: "assistant",
              providerID: "opencode",
              modelID: "test-model",
              time: { created },
              tokens: { input: tokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              ...extra,
            },
          },
        },
      })
    },
    // run one tool call through the after-hook and return the output text the model would get
    async toolCall(name = "read") {
      const output = { title: "t", output: "file contents", metadata: {} }
      await hooks["tool.execute.after"]({ tool: name, sessionID: SID, callID: "c", args: {} }, output)
      return output.output
    },
    async idle(kind: "session.idle" | "session.status" = "session.idle") {
      await hooks.event({
        event:
          kind === "session.idle"
            ? { type: "session.idle", properties: { sessionID: SID } }
            : { type: "session.status", properties: { sessionID: SID, status: { type: "idle" } } },
      })
    },
    async compactNow(args: { handoff: string; keep?: string } = { handoff: "HANDOFF.md", keep: "task and next step" }) {
      return hooks.tool.compact_now.execute(args, { sessionID: SID, messageID: "m", agent: "build" })
    },
  }
}

const logLines = (): any[] => {
  const f = join(logDir, `${SID}.jsonl`)
  return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []
}
const kinds = () => logLines().map((l) => l.kind)

describe("notes", () => {
  test("no note under the soft line", async () => {
    const t = await make()
    await t.assistant(4900) // 49%
    const out = await t.toolCall()
    expect(out).toBe("file contents")
    expect(kinds()).not.toContain("note")
  })

  test("exactly one soft note at 50%, then quiet until the strict line", async () => {
    const t = await make()
    await t.assistant(5000) // 50%
    const first = await t.toolCall()
    expect(first).toContain("[compact-when-ready]")
    expect(first).toContain("comfortable moment")
    expect(first).toContain("compact_now")
    await t.assistant(5400)
    expect(await t.toolCall()).toBe("file contents")
    await t.assistant(5900) // 59%
    expect(await t.toolCall()).toBe("file contents")
    expect(logLines().filter((l) => l.kind === "note").length).toBe(1)
    expect(logLines().find((l) => l.kind === "note").which).toBe("soft")
  })

  test("strict notes at 60% and then every 2 points", async () => {
    const t = await make()
    const got: Record<number, boolean> = {}
    for (const pct of [60, 61, 62, 63, 64, 65]) {
      await t.assistant(pct * 100)
      const out = await t.toolCall()
      got[pct] = out.includes("Save and compact now")
    }
    expect(got).toEqual({ 60: true, 61: false, 62: true, 63: false, 64: true, 65: false })
    expect(logLines().filter((l) => l.which === "strict").length).toBe(3)
  })

  test("the context is input + output + cache read + cache write of the latest message", async () => {
    const t = await make()
    await t.assistant(0, { tokens: { input: 1000, output: 500, reasoning: 0, cache: { read: 3000, write: 500 } } }) // 50%
    expect(await t.toolCall()).toContain("[compact-when-ready]")
  })

  test("a message with no tokens yet does not reset the percent", async () => {
    const t = await make()
    await t.assistant(5000)
    await t.assistant(0, { tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })
    expect(await t.toolCall()).toContain("[compact-when-ready]")
  })

  test("the window comes from client.config.providers() when no option is set", async () => {
    const t = await make({}, {
      providers: () => ({ data: { providers: [{ id: "opencode", models: { "test-model": { limit: { context: 10_000, output: 1 } } } }] } }),
    })
    await t.assistant(5000)
    expect(await t.toolCall()).toContain("[compact-when-ready]")
    expect(t.names()).toContain("providers")
  })

  test("no window known: no notes, one log line", async () => {
    const t = await make({})
    await t.assistant(5000)
    await t.assistant(9000)
    expect(await t.toolCall()).toBe("file contents")
    expect(logLines().filter((l) => l.kind === "no-window").length).toBe(1)
  })

  test("a soft line at or above the strict line turns the soft note off", async () => {
    const t = await make({ window: WINDOW, soft: 60, strict: 60 })
    await t.assistant(5500)
    expect(await t.toolCall()).toBe("file contents")
    await t.assistant(6000)
    expect(await t.toolCall()).toContain("Save and compact now")
  })

  test("custom lines from options", async () => {
    const t = await make({ window: WINDOW, soft: 10, strict: 20 })
    await t.assistant(1000)
    expect(await t.toolCall()).toContain("comfortable moment")
  })

  test("a subagent session gets no notes", async () => {
    const t = await make({ window: WINDOW }, { get: () => ({ data: { id: SID, parentID: "ses_parent" } }) })
    await t.assistant(7000)
    expect(await t.toolCall()).toBe("file contents")
    expect(await t.compactNow()).toContain("subagent")
  })
})

describe("compact_now and the idle step", () => {
  test("compact_now only records the request and answers", async () => {
    const t = await make()
    await t.assistant(6100)
    const answer = await t.compactNow()
    expect(answer).toBe("Compaction queued. End your turn now.")
    expect(t.names()).not.toContain("summarize") // nothing runs inside the tool call
    expect(kinds()).toContain("queued")
  })

  test("after compact_now, other tool results carry the queued note", async () => {
    const t = await make()
    await t.assistant(6100)
    await t.compactNow()
    expect(await t.toolCall()).toContain("Compaction is queued")
  })

  test("compact_now without a handoff path is refused and queues nothing", async () => {
    const t = await make()
    await t.assistant(6100)
    const answer = await t.compactNow({ handoff: "  " })
    expect(answer).toContain("handoff")
    await t.idle()
    expect(t.names()).not.toContain("summarize")
  })

  test("idle with the flag: summarize, then promptAsync, in that order", async () => {
    const t = await make()
    await t.assistant(6100)
    await t.compactNow({ handoff: "notes/HANDOFF.md", keep: "the parser rewrite" })
    await t.idle()
    const order = t.calls.filter((c) => c.name === "summarize" || c.name === "promptAsync")
    expect(order.map((c) => c.name)).toEqual(["summarize", "promptAsync"])
    expect(order[0]!.args).toEqual({ path: { id: SID }, body: { providerID: "opencode", modelID: "test-model" } })
    const prompt = order[1]!.args
    expect(prompt.path).toEqual({ id: SID })
    expect(prompt.body.parts[0].type).toBe("text")
    expect(prompt.body.parts[0].text).toContain("The conversation was just compacted at your request")
    expect(prompt.body.parts[0].text).toContain("notes/HANDOFF.md")
    expect(kinds()).toEqual(["start", "queued", "compacted", "continued"])
  })

  test("the flag is cleared: a second idle does nothing", async () => {
    const t = await make()
    await t.assistant(6100)
    await t.compactNow()
    await t.idle()
    await t.idle()
    await t.idle("session.status")
    expect(t.calls.filter((c) => c.name === "summarize").length).toBe(1)
    expect(t.calls.filter((c) => c.name === "promptAsync").length).toBe(1)
  })

  test("idle without the flag does nothing", async () => {
    const t = await make()
    await t.assistant(6100)
    await t.idle()
    await t.idle("session.status")
    expect(t.names()).not.toContain("summarize")
    expect(t.names()).not.toContain("promptAsync")
  })

  test("session.status idle also runs a queued compaction", async () => {
    const t = await make()
    await t.assistant(6100)
    await t.compactNow()
    await t.idle("session.status")
    expect(t.names().filter((n) => n === "summarize" || n === "promptAsync")).toEqual(["summarize", "promptAsync"])
  })

  test("the keep text reaches the summary through the compaction hook, only while a job runs", async () => {
    let during: string[] = []
    let t: Awaited<ReturnType<typeof make>>
    t = await make({ window: WINDOW }, {
      summarize: async () => {
        const out = { context: [] as string[] }
        await t.hooks["experimental.session.compacting"]({ sessionID: SID }, out)
        during = out.context
        return { data: true }
      },
    })
    await t.assistant(6100)
    await t.compactNow({ handoff: "H.md", keep: "the open decisions" })
    await t.idle()
    expect(during.join(" ")).toContain("the open decisions")
    expect(during.join(" ")).toContain("H.md")
    const after = { context: [] as string[] }
    await t.hooks["experimental.session.compacting"]({ sessionID: SID }, after)
    expect(after.context).toEqual([])
  })

  test("a summarize error is retried once, then the plugin gives up (thrown)", async () => {
    const t = await make({ window: WINDOW }, {
      summarize: () => {
        throw new Error("boom")
      },
    })
    await t.assistant(6100)
    await t.compactNow()
    await t.idle()
    expect(t.calls.filter((c) => c.name === "summarize").length).toBe(2)
    expect(t.names()).not.toContain("promptAsync")
    expect(t.names()).toContain("toast")
    expect(kinds().filter((k) => k === "summarize-failed").length).toBe(2)
    expect(kinds()).toContain("gave-up")
    await t.idle() // never loops: nothing more happens
    expect(t.calls.filter((c) => c.name === "summarize").length).toBe(2)
  })

  test("a summarize error is retried once, then the plugin gives up (error result)", async () => {
    const t = await make({ window: WINDOW }, { summarize: () => ({ error: { name: "UnknownError" } }) })
    await t.assistant(6100)
    await t.compactNow()
    await t.idle()
    expect(t.calls.filter((c) => c.name === "summarize").length).toBe(2)
    expect(kinds()).toContain("gave-up")
  })

  test("the retry can succeed", async () => {
    let n = 0
    const t = await make({ window: WINDOW }, {
      summarize: () => {
        n += 1
        if (n === 1) throw new Error("first fails")
        return { data: true }
      },
    })
    await t.assistant(6100)
    await t.compactNow()
    await t.idle()
    expect(t.names().filter((x) => x === "summarize" || x === "promptAsync")).toEqual(["summarize", "summarize", "promptAsync"])
    expect(kinds()).not.toContain("gave-up")
  })

  test("after giving up there are no notes, until the model calls compact_now again", async () => {
    const t = await make({ window: WINDOW }, { summarize: () => ({ error: "x" }) })
    await t.assistant(6100)
    await t.compactNow()
    await t.idle()
    await t.assistant(6500)
    expect(await t.toolCall()).toBe("file contents")
  })
})

describe("cycle", () => {
  test("a compaction summary message is ignored, and session.compacted starts the notes over", async () => {
    const t = await make()
    await t.assistant(5100)
    expect(await t.toolCall()).toContain("comfortable moment")
    await t.hooks.event({ event: { type: "session.compacted", properties: { sessionID: SID } } })
    await t.assistant(9000, { summary: true }) // the summary call's own tokens must not count
    expect(await t.toolCall()).toBe("file contents")
    await t.assistant(500) // the first message after it: the floor
    await t.assistant(5200)
    expect(await t.toolCall()).toContain("comfortable moment") // soft note again in the new cycle
    expect(kinds()).toContain("compacted-elsewhere")
  })

  test("after our own compaction the notes start over too", async () => {
    const t = await make()
    await t.assistant(6100)
    await t.compactNow()
    await t.idle()
    expect(await t.toolCall()).toBe("file contents") // percent unknown until the next assistant message
    await t.assistant(500) // the first message after it: the floor
    await t.assistant(5100)
    expect(await t.toolCall()).toContain("comfortable moment")
  })
})

describe("switches and log", () => {
  test("COMPACT_WHEN_READY_OFF=1 gives a plugin with no hooks and no tool", async () => {
    process.env.COMPACT_WHEN_READY_OFF = "1"
    const t = await make()
    expect(Object.keys(t.hooks)).toEqual([])
  })

  test("env lines win over options", async () => {
    process.env.COMPACT_WHEN_READY_SOFT = "10"
    process.env.COMPACT_WHEN_READY_STRICT = "20"
    process.env.COMPACT_WHEN_READY_WINDOW = "10000"
    const t = await make({ soft: 50, strict: 60, window: 999999 })
    await t.assistant(1000)
    expect(await t.toolCall()).toContain("comfortable moment")
  })

  test("log lines are JSON, one file per session, in the log folder only", async () => {
    const t = await make()
    await t.assistant(5100)
    await t.toolCall()
    expect(readdirSync(logDir)).toEqual([`${SID}.jsonl`])
    for (const l of logLines()) {
      expect(typeof l.at).toBe("string")
      expect(l.session).toBe(SID)
    }
    expect(kinds()).toEqual(["start", "note"])
  })

  test("a broken event does not throw", async () => {
    const t = await make()
    await t.hooks.event({ event: { type: "message.updated", properties: null } })
    await t.hooks.event({ event: { type: "session.idle", properties: {} } })
  })
})

describe("after the review fixes", () => {
  // F1: the continue prompt runs under the agent the user was in
  test("F1: the continue prompt carries the agent of the latest assistant message", async () => {
    const t = await make()
    await t.assistant(6100, { agent: "plan" })
    await t.compactNow()
    await t.idle()
    const prompt = t.calls.find((c) => c.name === "promptAsync")!.args
    expect(prompt.body.agent).toBe("plan")
    expect(prompt.body.model).toEqual({ providerID: "opencode", modelID: "test-model" })
  })

  test("F1: falls back to info.mode when there is no info.agent", async () => {
    const t = await make()
    await t.assistant(6100, { mode: "custom-readonly" })
    await t.compactNow()
    await t.idle()
    expect(t.calls.find((c) => c.name === "promptAsync")!.args.body.agent).toBe("custom-readonly")
  })

  test("F1: no agent known -> no agent field in the prompt", async () => {
    const t = await make()
    await t.assistant(6100)
    await t.compactNow()
    await t.idle()
    expect("agent" in t.calls.find((c) => c.name === "promptAsync")!.args.body).toBe(false)
  })

  // F2: a cancelled or errored turn keeps the request queued
  test("F2: idle after an aborted turn (0 tokens) keeps the request queued; the next normal idle compacts", async () => {
    const t = await make()
    await t.assistant(6100)
    await t.compactNow()
    await t.assistant(0, { error: { name: "MessageAbortedError", data: { message: "aborted" } } })
    await t.idle()
    expect(t.names()).not.toContain("summarize")
    expect(kinds()).toContain("idle-after-error")
    await t.idle("session.status") // still errored: still waits
    expect(t.names()).not.toContain("summarize")
    await t.assistant(6200) // the next turn ends normally
    await t.idle()
    expect(t.names().filter((n) => n === "summarize" || n === "promptAsync")).toEqual(["summarize", "promptAsync"])
  })

  test("F2: an errored message that carries tokens also keeps the request queued", async () => {
    const t = await make()
    await t.assistant(6100)
    await t.compactNow()
    await t.assistant(6300, { error: { name: "UnknownError", data: { message: "x" } } })
    await t.idle()
    expect(t.names()).not.toContain("summarize")
    expect(kinds()).toContain("idle-after-error")
  })

  // F3: a failed continue prompt does not switch the notes off for the new cycle
  test("F3: continue prompt failing twice logs continue-gave-up, toasts, and leaves the notes on", async () => {
    const t = await make({ window: WINDOW }, { promptAsync: () => ({ error: { name: "UnknownError" } }) })
    await t.assistant(6100)
    await t.compactNow()
    await t.idle()
    expect(t.calls.filter((c) => c.name === "promptAsync").length).toBe(2)
    expect(kinds()).toContain("continue-gave-up")
    expect(t.names()).toContain("toast")
    await t.assistant(500) // new cycle; the first message after the compaction is the floor
    await t.assistant(5100)
    expect(await t.toolCall()).toContain("comfortable moment")
  })

  // N1
  test("N1: unknown percent -> no 'context had reached' clause", async () => {
    const t = await make()
    await t.assistant(6100)
    await t.compactNow()
    await t.hooks.event({ event: { type: "session.compacted", properties: { sessionID: SID } } }) // pct -> -1 ... then queue again
    await t.compactNow()
    await t.idle()
    const text = t.calls.find((c) => c.name === "promptAsync")!.args.body.parts[0].text
    expect(text).not.toContain("-1")
    expect(text).not.toContain("context had reached")
    expect(text).toContain("HANDOFF.md")
  })

  test("N1: known percent keeps the clause", async () => {
    const t = await make()
    await t.assistant(6100)
    await t.compactNow()
    await t.idle()
    expect(t.calls.find((c) => c.name === "promptAsync")!.args.body.parts[0].text).toContain("(context had reached 61%)")
  })

  // N2
  test("N2: a providers lookup that threw is not cached; the next message retries", async () => {
    let n = 0
    const t = await make({}, {
      providers: () => {
        n += 1
        if (n === 1) throw new Error("transient")
        return { data: { providers: [{ id: "opencode", models: { "test-model": { limit: { context: 10_000, output: 1 } } } }] } }
      },
    })
    await t.assistant(5000) // lookup throws
    expect(await t.toolCall()).toBe("file contents")
    await t.assistant(5100) // lookup works now
    expect(await t.toolCall()).toContain("[compact-when-ready]")
  })

  test("N2: a clean 'not found' is cached (one providers call for many messages)", async () => {
    const t = await make({})
    await t.assistant(5000)
    await t.assistant(5100)
    await t.assistant(5200)
    expect(t.names().filter((n) => n === "providers").length).toBe(1)
  })
})

// A session whose fixed part (system prompt, tools, AGENTS.md) sits near the lines: a compaction frees almost nothing,
// so for that cycle the lines sit ten points above where it left the context (the Claude Code mod 0.3.5 rule).
describe("floor guard", () => {
  const floors = () => logLines().filter((l) => l.kind === "high-floor")

  test("a compaction that leaves 51% lifts both lines to 61% for that cycle, with one toast", async () => {
    const t = await make()
    await t.assistant(5200)
    expect(await t.toolCall()).toContain("comfortable moment")
    await t.compactNow()
    await t.idle()
    await t.assistant(5100) // the compaction freed almost nothing
    expect(await t.toolCall()).toBe("file contents") // no soft note at 51
    await t.assistant(6000)
    expect(await t.toolCall()).toBe("file contents") // no strict note at 60 either
    await t.assistant(6100)
    const out = await t.toolCall()
    expect(out).toContain("Save and compact now")
    expect(out).toContain("61%")
    expect(floors().map((l) => [l.floor, l.soft, l.strict])).toEqual([[51, 61, 61]])
    expect(t.calls.filter((c) => c.name === "toast").length).toBe(1)
    expect(JSON.stringify(t.calls.find((c) => c.name === "toast")?.args)).toContain("the next note waits for 61%")
  })

  test("a compaction that leaves 40% or less keeps the lines as set, with no toast", async () => {
    const t = await make()
    await t.assistant(6100)
    await t.compactNow()
    await t.idle()
    await t.assistant(4000) // 40 + 10 is the soft line itself
    expect(await t.toolCall()).toBe("file contents")
    await t.assistant(5000)
    expect(await t.toolCall()).toContain("comfortable moment")
    expect(floors()).toEqual([])
    expect(t.names()).not.toContain("toast")
  })

  test("OpenCode's own compaction sets the floor too; a second cycle near the lines logs again, with no second toast", async () => {
    const t = await make()
    await t.assistant(7000)
    await t.hooks.event({ event: { type: "session.compacted", properties: { sessionID: SID } } })
    await t.assistant(9000, { summary: true }) // the summary call's own tokens never set the floor
    await t.assistant(5500)
    expect(await t.toolCall()).toBe("file contents") // both lines at 65: the soft one is off
    await t.assistant(6500)
    expect(await t.toolCall()).toContain("65%")
    await t.hooks.event({ event: { type: "session.compacted", properties: { sessionID: SID } } })
    await t.assistant(5600)
    expect(await t.toolCall()).toBe("file contents")
    expect(floors().map((l) => l.floor)).toEqual([55, 56])
    expect(t.calls.filter((c) => c.name === "toast").length).toBe(1)
  })

  test("before any compaction there is no floor, even when the session starts high", async () => {
    const t = await make()
    await t.assistant(5100) // a session that starts at 51%
    expect(await t.toolCall()).toContain("comfortable moment")
    expect(floors()).toEqual([])
  })
})
