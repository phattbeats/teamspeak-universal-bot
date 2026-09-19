/**
 * `what_did_i_miss` against the Sexton logger's real on-disk format.
 *
 * The line grammar and the `<logDir>/<channel>/YYYY-MM-DD.md` layout are owned
 * by sexton/src/main.rs; the last test writes an actual file and reads it back
 * through the default reader so a change to that layout fails here rather than
 * in the channel.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ChannelLogError, parseLogLine, readChannelLog } from "../src/tools/catch-up.js";

const NOW = new Date(2026, 8, 6, 18, 30, 0);

function stamp(date: Date): string {
  return `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, "0")}-${`${date.getDate()}`.padStart(2, "0")}`;
}

const TODAY = stamp(NOW);
const YESTERDAY = stamp(new Date(NOW.getTime() - 24 * 60 * 60 * 1_000));

function reader(files: Record<string, string>) {
  return async (path: string): Promise<string> => {
    const body = files[path];
    if (body === undefined) {
      throw new Error(`ENOENT: ${path}`);
    }
    return body;
  };
}

describe("parseLogLine", () => {
  it("reads the logger's rendered line", () => {
    expect(parseLogLine("18:04  Brandon: hello there")).toEqual({
      time: "18:04",
      nickname: "Brandon",
      text: "hello there",
      line: "18:04  Brandon: hello there",
    });
  });

  it("keeps a message that itself contains a colon", () => {
    expect(parseLogLine("18:04  Brandon: url: https://x.test")?.text).toBe("url: https://x.test");
  });

  it("skips anything not in that exact shape, the way the Rust parser does", () => {
    // The description header the Sexton writes above the rolling log.
    expect(
      parseLogLine(
        "— the Sexton keeps this hall: the last lines stay here, the whole log is kept below. Ask him and he'll fetch the rest. —",
      ),
    ).toBeUndefined();
    expect(parseLogLine("")).toBeUndefined();
    expect(parseLogLine("8:04  Brandon: short hour")).toBeUndefined();
    expect(parseLogLine("18:04 Brandon: single space")).toBeUndefined();
    expect(parseLogLine("18:04  : empty nickname")).toBeUndefined();
  });

  it("tolerates CRLF", () => {
    expect(parseLogLine("18:04  Brandon: hi\r")?.text).toBe("hi");
  });
});

describe("readChannelLog", () => {
  const logDir = "/mnt/user/appdata/sexton";
  const channelName = "General Shit";
  const todayPath = join(logDir, channelName, `${TODAY}.md`);
  const yesterdayPath = join(logDir, channelName, `${YESTERDAY}.md`);

  it("returns the last N lines when no window is given", async () => {
    const result = await readChannelLog({
      logDir,
      channelName,
      limit: 2,
      now: NOW,
      readFile: reader({
        [todayPath]: "17:00  Brandon: one\n17:30  Kai: two\n18:00  Brandon: three\n",
      }),
    });

    expect(result.lines).toEqual(["17:30  Kai: two", "18:00  Brandon: three"]);
    expect(result.entries[1]?.nickname).toBe("Brandon");
  });

  it("filters to a minutes window using the file's date plus HH:MM", async () => {
    const result = await readChannelLog({
      logDir,
      channelName,
      minutes: 45,
      limit: 40,
      now: NOW,
      readFile: reader({
        [todayPath]: "17:00  Brandon: old\n18:00  Kai: recent\n18:20  Brandon: newest\n",
      }),
    });

    expect(result.lines).toEqual(["18:00  Kai: recent", "18:20  Brandon: newest"]);
  });

  it("reads yesterday too, so a window that crosses midnight is not empty", async () => {
    const result = await readChannelLog({
      logDir,
      channelName,
      limit: 5,
      now: NOW,
      readFile: reader({
        [yesterdayPath]: "23:50  Kai: last night\n",
        [todayPath]: "00:05  Brandon: this morning\n",
      }),
    });

    expect(result.lines).toEqual(["23:50  Kai: last night", "00:05  Brandon: this morning"]);
    expect(result.filesRead).toEqual([yesterdayPath, todayPath]);
  });

  it("counts unparseable lines instead of failing on them", async () => {
    const result = await readChannelLog({
      logDir,
      channelName,
      limit: 5,
      now: NOW,
      readFile: reader({
        [todayPath]: "# hand-added heading\n18:00  Kai: real message\n",
      }),
    });

    expect(result.lines).toEqual(["18:00  Kai: real message"]);
    expect(result.skippedLines).toBe(1);
  });

  it("returns nothing when the channel has no log yet", async () => {
    const result = await readChannelLog({
      logDir,
      channelName,
      limit: 5,
      now: NOW,
      readFile: reader({}),
    });

    expect(result.entries).toEqual([]);
    expect(result.filesRead).toEqual([]);
  });

  it("refuses a channel name that would escape the log root", async () => {
    await expect(
      readChannelLog({
        logDir,
        channelName: "../../etc",
        limit: 5,
        now: NOW,
        readFile: reader({}),
      }),
    ).rejects.toBeInstanceOf(ChannelLogError);
  });

  it("reads a real file written in the logger's layout", async () => {
    const root = await mkdtemp(join(tmpdir(), "sexton-catchup-"));
    await mkdir(join(root, channelName), { recursive: true });
    await writeFile(
      join(root, channelName, `${TODAY}.md`),
      "18:01  Brandon: first\n18:02  Kai: second\n",
      "utf8",
    );

    const result = await readChannelLog({ logDir: root, channelName, limit: 15, now: NOW });
    expect(result.lines).toEqual(["18:01  Brandon: first", "18:02  Kai: second"]);
  });
});
