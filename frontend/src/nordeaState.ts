import type { NordeaTransaction, NordeaTransactionsResponse } from "./types";

export type TransactionPageOptions = {
    limit: number;
    offset: number;
};

export function localLedgerFirstPage(limit: number): TransactionPageOptions {
    return {
        limit,
        offset: 0,
    };
}

export function computeAllTransactionsLoaded(payload: NordeaTransactionsResponse): boolean {
    return !payload.has_more || payload.transactions.length >= payload.transaction_count;
}

export function mergeUpdatedTransactions(
    current: NordeaTransactionsResponse | null,
    updatedTransactions: NordeaTransaction[] | undefined,
    deletedTransactionIds?: string[],
): NordeaTransactionsResponse | null {
    if (current === null) {
        return current;
    }

    const deletedIds = new Set(deletedTransactionIds ?? []);
    if ((!updatedTransactions || updatedTransactions.length === 0) && deletedIds.size === 0) {
        return current;
    }

    const nextUpdatedTransactions = updatedTransactions ?? [];
    const updatedById = new Map(nextUpdatedTransactions.map((transaction) => [transaction.id, transaction]));
    const preservedIds = new Set<string>();
    const deletedLoadedCount = current.transactions.filter((transaction) => deletedIds.has(transaction.id)).length;
    const merged = current.transactions.filter((transaction) => !deletedIds.has(transaction.id)).map((transaction) => {
        const updated = updatedById.get(transaction.id);
        if (updated) {
            preservedIds.add(transaction.id);
            return updated;
        }
        return transaction;
    });

    for (const updated of nextUpdatedTransactions) {
        if (!preservedIds.has(updated.id)) {
            merged.push(updated);
        }
    }

    merged.sort((left, right) => {
        if (left.booking_date !== right.booking_date) {
            return String(right.booking_date || "").localeCompare(String(left.booking_date || ""));
        }
        return String(right.entry_reference || "").localeCompare(String(left.entry_reference || ""));
    });

    const previousById = new Map(current.transactions.map((transaction) => [transaction.id, transaction]));
    let pendingReviewCount = current.pending_review_count ?? 0;
    for (const updated of nextUpdatedTransactions) {
        const previous = previousById.get(updated.id);
        if (!previous) {
            continue;
        }

        const previousPending = Boolean(previous.pending_review);
        const updatedPending = Boolean(updated.pending_review);
        if (previousPending === updatedPending) {
            continue;
        }
        pendingReviewCount += updatedPending ? 1 : -1;
    }

    const transactionCount = Math.max(current.transaction_count - deletedLoadedCount, merged.length);
    const loadedCount = merged.length;
    return {
        ...current,
        transactions: merged,
        transaction_count: transactionCount,
        loaded_count: loadedCount,
        has_more: transactionCount > loadedCount,
        pending_review_count: pendingReviewCount,
    };
}
