import { beforeEach, describe, expect, test } from "bun:test";
import {
  checkReplyLoop,
  recordReply,
  resetReplyLoopForTests,
} from "@/graph/reply-loop";

const LIM = { max: 3, windowMs: 60_000, pauseMs: 300_000 };

describe("reply-loop guard", () => {
  beforeEach(() => resetReplyLoopForTests());

  test("a conversation under the limit is answered", () => {
    recordReply("t1", 0);
    recordReply("t1", 1_000);
    expect(checkReplyLoop("t1", 2_000, LIM)).toEqual({ held: false });
  });

  test("past the limit inside the window it trips once, then holds", () => {
    for (const t of [0, 1_000, 2_000]) recordReply("t1", t);
    expect(checkReplyLoop("t1", 3_000, LIM)).toEqual({
      held: true,
      tripped: true,
      replies: 3,
    });
    expect(checkReplyLoop("t1", 4_000, LIM)).toEqual({
      held: true,
      tripped: false,
      replies: 0,
    });
  });

  test("the pause ends and the count starts over", () => {
    for (const t of [0, 1_000, 2_000]) recordReply("t1", t);
    checkReplyLoop("t1", 3_000, LIM);
    expect(checkReplyLoop("t1", 3_000 + LIM.pauseMs, LIM)).toEqual({
      held: false,
    });
  });

  test("replies older than the window do not count", () => {
    for (const t of [0, 1_000, 2_000]) recordReply("t1", t);
    expect(checkReplyLoop("t1", 70_000, LIM)).toEqual({ held: false });
  });

  test("conversations are counted apart", () => {
    for (const t of [0, 1_000, 2_000]) recordReply("t1", t);
    expect(checkReplyLoop("t2", 3_000, LIM)).toEqual({ held: false });
  });
});
