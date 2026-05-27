import { describe, expect, it } from "vitest";

import { formatSplitDraftAmount, parseSplitDraftAmount } from "./splitAmount";

describe("splitAmount", () => {
    it("parses Spiir-style signed comma amounts", () => {
        expect(parseSplitDraftAmount("48033,30")).toBe(48033.3);
        expect(parseSplitDraftAmount("-420")).toBe(-420);
        expect(parseSplitDraftAmount("  -420,50 ")).toBe(-420.5);
    });

    it("keeps partial text invalid until it is a number", () => {
        expect(Number.isNaN(parseSplitDraftAmount("-"))).toBe(true);
        expect(Number.isNaN(parseSplitDraftAmount(""))).toBe(true);
        expect(Number.isNaN(parseSplitDraftAmount("12,3,4"))).toBe(true);
    });

    it("formats draft amounts like Spiir input text", () => {
        expect(formatSplitDraftAmount(48033.3)).toBe("48033,3");
        expect(formatSplitDraftAmount(-420)).toBe("-420");
    });
});