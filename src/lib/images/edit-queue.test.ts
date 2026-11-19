import { describe, expect, it } from "vitest";
import { EditError, JOB_TIMEOUT_MESSAGE, MAX_WAITING, QUEUE_BUSY_MESSAGE, runOneAtATime } from "./edit";

const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };

describe("runOneAtATime", () => {
  it("refuses a new job when 3 are already waiting, then accepts again", async () => {
    const g = gate();
    const running = runOneAtATime(() => g.p);
    await Promise.resolve();
    const waiting = Array.from({ length: MAX_WAITING }, () => runOneAtATime(async () => 1));
    await expect(runOneAtATime(async () => 1)).rejects.toMatchObject({ userMessage: QUEUE_BUSY_MESSAGE });
    g.open();
    await running;
    expect(await Promise.all(waiting)).toEqual([1, 1, 1]);
    expect(await runOneAtATime(async () => 2)).toBe(2);
  });

  it("gives up on a job after its time limit, frees the line and tells the job", async () => {
    const g = gate();
    let sawExpired = false;
    const slow = runOneAtATime(async (ctl) => { await g.p; sawExpired = ctl.expired(); }, 20);
    const after = runOneAtATime(async () => "next");
    await expect(slow).rejects.toBeInstanceOf(EditError);
    await expect(slow).rejects.toMatchObject({ userMessage: JOB_TIMEOUT_MESSAGE });
    expect(await after).toBe("next");
    g.open();
    await new Promise((r) => setTimeout(r, 5));
    expect(sawExpired).toBe(true);
  });
});
