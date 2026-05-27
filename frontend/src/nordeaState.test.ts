import { describe, expect, it } from "vitest";

import { computeAllTransactionsLoaded, localLedgerFirstPage, mergeUpdatedTransactions } from "./nordeaState";
import type { NordeaTransaction, NordeaTransactionsResponse } from "./types";

function makeTransaction(overrides: Partial<NordeaTransaction>): NordeaTransaction {
    return {
        id: "tx-default",
        entry_reference: "ref-default",
        booking_date: "2026-01-01",
        amount: -100,
        currency: "DKK",
        description: "Test",
        hashtags: [],
        is_extraordinary: false,
        splits: [],
        source: "nordea-local-ledger",
        ...overrides,
    };
}

function makeResponse(overrides: Partial<NordeaTransactionsResponse>): NordeaTransactionsResponse {
    return {
        transaction_count: 0,
        pending_review_count: 0,
        loaded_count: 0,
        offset: 0,
        limit: 300,
        has_more: false,
        accounts: [],
        transactions: [],
        ...overrides,
    };
}

describe("nordeaState", () => {
    it("builds local-ledger first page options", () => {
        expect(localLedgerFirstPage(300)).toEqual({ limit: 300, offset: 0 });
    });

    it("computes all-transactions-loaded flag", () => {
        const hasMore = makeResponse({ transaction_count: 10, transactions: [makeTransaction({ id: "1" })], has_more: true });
        const noMore = makeResponse({ transaction_count: 10, transactions: [makeTransaction({ id: "1" })], has_more: false });
        const fullCountLoaded = makeResponse({ transaction_count: 1, transactions: [makeTransaction({ id: "1" })], has_more: true });

        expect(computeAllTransactionsLoaded(hasMore)).toBe(false);
        expect(computeAllTransactionsLoaded(noMore)).toBe(true);
        expect(computeAllTransactionsLoaded(fullCountLoaded)).toBe(true);
    });

    it("merges updates without corrupting global pagination metadata", () => {
        const current = makeResponse({
            transaction_count: 20000,
            pending_review_count: 1,
            loaded_count: 2,
            has_more: true,
            transactions: [
                makeTransaction({ id: "a", entry_reference: "1", booking_date: "2026-02-02", pending_review: true }),
                makeTransaction({ id: "b", entry_reference: "2", booking_date: "2026-02-01", pending_review: false }),
            ],
        });

        const merged = mergeUpdatedTransactions(current, [
            makeTransaction({ id: "a", entry_reference: "1", booking_date: "2026-02-03", pending_review: false }),
            makeTransaction({ id: "c", entry_reference: "3", booking_date: "2026-01-20", pending_review: false }),
        ]);

        expect(merged).not.toBeNull();
        expect(merged?.transaction_count).toBe(20000);
        expect(merged?.loaded_count).toBe(3);
        expect(merged?.has_more).toBe(true);
        expect(merged?.pending_review_count).toBe(0);
        expect(merged?.transactions.map((transaction) => transaction.id)).toEqual(["a", "b", "c"]);
    });

    it("removes deleted transactions while merging updates", () => {
        const current = makeResponse({
            transaction_count: 3,
            loaded_count: 3,
            transactions: [
                makeTransaction({ id: "a", entry_reference: "1", booking_date: "2026-02-02" }),
                makeTransaction({ id: "b", entry_reference: "2", booking_date: "2026-02-01" }),
                makeTransaction({ id: "c", entry_reference: "3", booking_date: "2026-01-20" }),
            ],
        });

        const merged = mergeUpdatedTransactions(
            current,
            [makeTransaction({ id: "a", entry_reference: "1", booking_date: "2026-02-02", amount: -250 })],
            ["b"],
        );

        expect(merged?.transaction_count).toBe(2);
        expect(merged?.loaded_count).toBe(2);
        expect(merged?.transactions.map((transaction) => transaction.id)).toEqual(["a", "c"]);
        expect(merged?.transactions[0].amount).toBe(-250);
    });
});
