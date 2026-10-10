import { describe, expect, it, vi } from "vitest";
import { chooseRoutingMember } from "../lib/routing-selection.js";

const members = [{ id: "a", weight: 1 }, { id: "b", weight: 3 }, { id: "c", weight: 2 }];
describe("routing selection", () => {
  it("gives each member one equal slot regardless of weight in RANDOM", () => {
    const draw = vi.fn((max: number) => max - 1);
    expect(chooseRoutingMember(members, "RANDOM", draw).id).toBe("c");
    expect(draw).toHaveBeenCalledExactlyOnceWith(3);
    expect([0, 1, 2].map(ticket => chooseRoutingMember(members, "RANDOM", () => ticket).id)).toEqual(["a", "b", "c"]);
  });
  it("partitions every weighted ticket at the correct boundaries", () => {
    const results = Array.from({ length: 6 }, (_, ticket) => chooseRoutingMember(members, "WEIGHTED_RANDOM", () => ticket).id);
    expect(results).toEqual(["a", "b", "b", "b", "c", "c"]);
  });
  it("passes the total weight as the exclusive random bound", () => {
    const draw = vi.fn(() => 0);
    expect(chooseRoutingMember(members, "WEIGHTED_RANDOM", draw)).toBe(members[0]);
    expect(draw).toHaveBeenCalledExactlyOnceWith(6);
  });
  it("works with a single candidate", () => {
    expect(chooseRoutingMember([members[1]!], "RANDOM")).toBe(members[1]);
  });
  it("refuses empty groups without drawing", () => {
    const draw = vi.fn();
    expect(() => chooseRoutingMember([], "RANDOM", draw)).toThrow(expect.objectContaining({ code: "ROUTING_GROUP_NO_CHANNEL" }));
    expect(draw).not.toHaveBeenCalled();
  });
  it.each([0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects unsafe weight %s", weight => {
    expect(() => chooseRoutingMember([{ weight }], "WEIGHTED_RANDOM")).toThrow(expect.objectContaining({ code: "ROUTING_WEIGHT_INVALID" }));
  });
  it("supports the maximum configured group size and weight", () => {
    const candidates = Array.from({ length: 100 }, (_, id) => ({ id, weight: 10_000 }));
    const draw = vi.fn((max: number) => max - 1);
    expect(chooseRoutingMember(candidates, "WEIGHTED_RANDOM", draw).id).toBe(99);
    expect(draw).toHaveBeenCalledExactlyOnceWith(1_000_000);
  });
});
