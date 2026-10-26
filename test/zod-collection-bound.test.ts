import { expect, it, vi } from "vitest";
import { z } from "zod";

it("rejects oversized constrained collections before walking their elements", () => {
  const element = vi.fn((value: unknown) => value);
  const schema = z.array(z.preprocess(element, z.string())).max(2);
  const result = schema.safeParse([0, 0, 0]);
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues).toHaveLength(1);
    expect(result.error.issues[0].code).toBe("too_big");
  }
  expect(element).not.toHaveBeenCalled();
});
