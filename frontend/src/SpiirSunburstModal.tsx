import { useEffect, useMemo, useState } from "react";
import Plot from "react-plotly.js";

import type { SpiirOverviewRow, SpiirTransaction } from "./types";

export type SunburstMode = "months" | "years";

export type SunburstState = {
    title: string;
    mode: SunburstMode;
    periods: string[];
    rows: SpiirOverviewRow[];
} | null;

type PlotlyGraphDiv = HTMLElement & {
    on: (eventName: string, handler: (event: any) => void) => void;
    removeListener: (eventName: string, handler: (event: any) => void) => void;
};

type SpiirSunburstFigure = {
    data: object[];
    layout: object;
    periodTransactions: SpiirTransaction[];
};

type SpiirSunburstModalProps = {
    state: NonNullable<SunburstState>;
    transactions?: SpiirTransaction[] | null;
    closeOnEscape?: boolean;
    allowPosts?: boolean;
    ensureTransactionsLoaded?: () => Promise<SpiirTransaction[]>;
    onClose: () => void;
    onOpenTransactions?: (title: string, items: SpiirTransaction[]) => void;
};

function formatNumber(value: number | null | undefined): string {
    if (value === null || value === undefined || Number.isNaN(value)) {
        return "";
    }
    return new Intl.NumberFormat("da-DK", { maximumFractionDigits: 0 }).format(value);
}

function formatTxDate(value: string): string {
    const [year, month, day] = value.split("-");
    return `${day}/${month}/${year}`;
}

function truncateText(value: string | null | undefined, maxLength: number): string {
    const text = String(value ?? "");
    if (text.length <= maxLength) {
        return text;
    }
    return `${text.slice(0, maxLength)}..`;
}

function formatCompact(value: number): string {
    const absolute = Math.abs(value);
    if (absolute >= 1_000_000) {
        return `${(absolute / 1_000_000).toFixed(1)}M`;
    }
    if (absolute >= 1_000) {
        return `${(absolute / 1_000).toFixed(absolute < 10_000 ? 1 : 0)}K`;
    }
    return formatNumber(absolute);
}

export function hash32(value: string): number {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function hsla(hue: number, saturation: number, lightness: number, alpha: number): string {
    return `hsla(${hue}, ${saturation}%, ${lightness}%, ${alpha})`;
}

export function expenseMainColorFromHue(hue: number, alpha: number, lightness = 54): string {
    return hsla(hue, 72, lightness, alpha);
}

export function expenseSubColorFromHue(hue: number, sub: string, alpha: number): string {
    const lightness = 40 + (hash32(sub) % 26);
    return hsla(hue, 72, Math.max(38, Math.min(72, lightness)), alpha);
}

export function incomePartColorFromHue(hue: number, label: string, alpha: number): string {
    const lightness = 38 + (hash32(label) % 26);
    return hsla(hue, 62, Math.max(36, Math.min(70, lightness)), alpha);
}

function rowTotalForPeriods(row: SpiirOverviewRow, periods: string[]): number {
    return periods.reduce((sum, period) => sum + Number(row.values[period] ?? 0), 0);
}

function compareLocale(left: string | null | undefined, right: string | null | undefined): number {
    return String(left ?? "").localeCompare(String(right ?? ""), "da");
}

function splitPair(value: string): [string, string] {
    const index = value.indexOf("|||");
    if (index === -1) {
        return [value, ""];
    }
    return [value.slice(0, index), value.slice(index + 3)];
}

function makePair(left: string, right: string): string {
    return `${left}|||${right}`;
}

function normalizeLabel(value: string | null | undefined): string {
    const next = String(value ?? "").trim();
    return next || "Uncategorized";
}

function filterTransactionsByPeriods(transactions: SpiirTransaction[], mode: SunburstMode, periods: string[]): SpiirTransaction[] {
    const set = new Set(periods);
    if (mode === "years") {
        return transactions.filter((transaction) => set.has(transaction.year));
    }
    return transactions.filter((transaction) => set.has(transaction.yyyymm));
}

function sunburstTitle(mode: SunburstMode, periods: string[]): string {
    if (periods.length === 0) {
        return mode === "years" ? "År" : "Måneder";
    }
    return mode === "years"
        ? `År: ${periods[0]}-${periods[periods.length - 1]}`
        : `Måneder: ${periods[0]}-${periods[periods.length - 1]}`;
}

function sunburstFilterFromId(id: string): { label: string; match: (transaction: SpiirTransaction) => boolean } | null {
    const parts = String(id).split("|");
    if (parts.length < 2 || parts[0] !== "T") {
        return null;
    }
    const kind = parts[1];
    const main = parts[2] ?? "";
    const sub = parts[3] ?? "";

    const refundParts = (value: string): { main: string; sub: string } => {
        const bits = String(value).split(" / ");
        if (bits.length >= 2) {
            return { main: bits[0].trim(), sub: bits.slice(1).join(" / ").trim() };
        }
        return { main: value.trim(), sub: "" };
    };

    if (kind === "Income") {
        if (main === "Refunds") {
            if (sub) {
                const refund = refundParts(sub);
                return {
                    label: sub,
                    match: (transaction) => transaction.categoryType === "Expense"
                        && Number(transaction.amount ?? 0) > 0
                        && (!refund.main || transaction.mainCategoryName === refund.main)
                        && (!refund.sub || transaction.categoryName === refund.sub)
                };
            }
            return {
                label: "Refunds",
                match: (transaction) => transaction.categoryType === "Expense" && Number(transaction.amount ?? 0) > 0
            };
        }
        if (!main) {
            return { label: "Income", match: (transaction) => transaction.categoryType === "Income" };
        }
        if (!sub) {
            return {
                label: main,
                match: (transaction) => transaction.categoryType === "Income" && transaction.mainCategoryName === main
            };
        }
        return {
            label: sub,
            match: (transaction) => transaction.categoryType === "Income"
                && transaction.mainCategoryName === main
                && transaction.categoryName === sub
        };
    }

    if (kind === "Expense") {
        if (!main) {
            return {
                label: "Expense",
                match: (transaction) => transaction.categoryType === "Expense" && Number(transaction.amount ?? 0) < 0
            };
        }
        if (!sub) {
            return {
                label: main,
                match: (transaction) => transaction.categoryType === "Expense"
                    && Number(transaction.amount ?? 0) < 0
                    && transaction.mainCategoryName === main
            };
        }
        return {
            label: sub,
            match: (transaction) => transaction.categoryType === "Expense"
                && Number(transaction.amount ?? 0) < 0
                && transaction.mainCategoryName === main
                && transaction.categoryName === sub
        };
    }

    return null;
}

function sunburstIdHasChildren(figure: { data: object[]; layout: object } | null, id: string): boolean {
    const trace = figure?.data?.[0] as { parents?: string[] } | undefined;
    if (!trace?.parents) {
        return false;
    }
    return trace.parents.some((parent) => parent === id);
}

function sunburstRefundLabel(main: string, sub: string): string {
    return sub && sub !== main ? `${main} / ${sub}` : main || "Refund";
}

function sunburstTransactionParentId(transaction: SpiirTransaction): string | null {
    const amount = Number(transaction.amount ?? 0);
    const main = normalizeLabel(transaction.mainCategoryName);
    const sub = normalizeLabel(transaction.categoryName);

    if (transaction.categoryType === "Income" && amount > 0) {
        return `T|Income|${main}|${sub}`;
    }

    if (transaction.categoryType === "Expense" && amount < 0) {
        return `T|Expense|${main}|${sub}`;
    }

    if (transaction.categoryType === "Expense" && amount > 0) {
        const refundLabel = sunburstRefundLabel(main, sub);
        return `T|Income|Refunds|${refundLabel}`;
    }

    return null;
}

function sunburstTransactionValue(transaction: SpiirTransaction): number {
    const amount = Number(transaction.amount ?? 0);
    if (transaction.categoryType === "Expense" && amount < 0) {
        return -amount;
    }
    return amount > 0 ? amount : 0;
}

function sunburstTransactionLabel(transaction: SpiirTransaction): string {
    const description = truncateText(transaction.description || transaction.comment || transaction.categoryName || "Post", 28);
    return `${formatTxDate(transaction.ymd)} · ${description}`;
}

function sunburstTransactionColor(transaction: SpiirTransaction): string {
    const amount = Number(transaction.amount ?? 0);
    const main = normalizeLabel(transaction.mainCategoryName);
    if (transaction.categoryType === "Expense" && amount < 0) {
        return expenseSubColorFromHue(hash32(main) % 360, transaction.description || transaction.categoryName || main, 0.34);
    }
    return incomePartColorFromHue(135 + (hash32(`${main}|${transaction.categoryName ?? ""}`) % 50), transaction.description || transaction.categoryName || main, 0.38);
}

function buildSunburstFigureFromRows(rows: SpiirOverviewRow[], periods: string[]): SpiirSunburstFigure {
    const byKey = new Map(rows.map((row) => [row.key, row]));
    const incomeByMain = new Map<string, number>();
    const incomeBySub = new Map<string, number>();
    const expenseByMain = new Map<string, number>();
    const expenseBySub = new Map<string, number>();

    rows
        .filter((row) => row.kind === "sub" && row.parent === "income")
        .forEach((row) => {
            const value = rowTotalForPeriods(row, periods);
            if (value <= 0) {
                return;
            }
            const main = normalizeLabel(row.mainCategoryName || "Income");
            const sub = normalizeLabel(row.categoryName || row.label);
            incomeByMain.set(main, (incomeByMain.get(main) ?? 0) + value);
            incomeBySub.set(makePair(main, sub), (incomeBySub.get(makePair(main, sub)) ?? 0) + value);
        });

    rows
        .filter((row) => row.kind === "sub" && !!row.parent && byKey.get(String(row.parent))?.parent === "expense")
        .forEach((row) => {
            const value = rowTotalForPeriods(row, periods);
            const main = normalizeLabel(row.mainCategoryName || byKey.get(String(row.parent))?.label || "Uncategorized");
            const sub = normalizeLabel(row.categoryName || row.label);

            if (value < 0) {
                const positiveValue = -value;
                expenseByMain.set(main, (expenseByMain.get(main) ?? 0) + positiveValue);
                expenseBySub.set(makePair(main, sub), (expenseBySub.get(makePair(main, sub)) ?? 0) + positiveValue);
                return;
            }

            if (value > 0) {
                const refundLabel = sunburstRefundLabel(main, sub);
                incomeByMain.set("Refunds", (incomeByMain.get("Refunds") ?? 0) + value);
                incomeBySub.set(makePair("Refunds", refundLabel), (incomeBySub.get(makePair("Refunds", refundLabel)) ?? 0) + value);
            }
        });

    const sortEntries = (left: [string, number], right: [string, number]): number => right[1] - left[1] || compareLocale(left[0], right[0]);
    const incomeMainEntries = [...incomeByMain.entries()].filter(([, value]) => value > 0).sort(sortEntries);
    const expenseMainEntries = [...expenseByMain.entries()].filter(([, value]) => value > 0).sort(sortEntries);
    const incomeTotal = incomeMainEntries.reduce((sum, [, value]) => sum + value, 0);
    const expenseTotal = expenseMainEntries.reduce((sum, [, value]) => sum + value, 0);
    const savings = Math.max(0, incomeTotal - expenseTotal);
    const debt = Math.max(0, expenseTotal - incomeTotal);

    const ids: string[] = [];
    const labels: string[] = [];
    const parents: string[] = [];
    const values: number[] = [];
    const colors: string[] = [];
    const text: string[] = [];

    const add = (id: string, label: string, parent: string, value: number, color: string): void => {
        if (value <= 0) {
            return;
        }
        ids.push(id);
        labels.push(label);
        parents.push(parent);
        values.push(value);
        colors.push(color);
        text.push(`${label}<br>${formatCompact(value)}`);
    };

    const incomeRoot = "T|Income";
    const expenseRoot = "T|Expense";
    add(incomeRoot, "Income", "", incomeTotal, "rgba(31, 107, 92, 0.34)");
    add(expenseRoot, "Expense", "", expenseTotal, "rgba(142, 59, 46, 0.28)");

    incomeMainEntries.forEach(([main, value]) => {
        const mainId = `T|Income|${main}`;
        add(mainId, main, incomeRoot, value, incomePartColorFromHue(135 + (hash32(main) % 50), main, 0.66));
        [...incomeBySub.entries()]
            .map(([key, total]) => ({ pair: splitPair(key), total }))
            .filter(({ pair, total }) => pair[0] === main && total > 0)
            .sort((left, right) => right.total - left.total || compareLocale(left.pair[1], right.pair[1]))
            .forEach(({ pair, total }) => add(`T|Income|${main}|${pair[1]}`, pair[1], mainId, total, incomePartColorFromHue(135 + (hash32(`${main}|${pair[1]}`) % 50), pair[1], 0.5)));
    });

    if (savings > 0) {
        add("T|Savings", "Savings", "", savings, "rgba(143, 122, 72, 0.28)");
    }

    expenseMainEntries.forEach(([main, value]) => {
        const mainId = `T|Expense|${main}`;
        const hue = hash32(main) % 360;
        add(mainId, main, expenseRoot, value, expenseMainColorFromHue(hue, 0.66, 60));
        [...expenseBySub.entries()]
            .map(([key, total]) => ({ pair: splitPair(key), total }))
            .filter(({ pair, total }) => pair[0] === main && total > 0)
            .sort((left, right) => right.total - left.total || compareLocale(left.pair[1], right.pair[1]))
            .forEach(({ pair, total }) => add(`T|Expense|${main}|${pair[1]}`, pair[1], mainId, total, expenseSubColorFromHue(hue, pair[1], 0.5)));
    });

    if (debt > 0) {
        add("T|Debt", "Debt", "", debt, "rgba(142, 59, 46, 0.22)");
    }

    return {
        data: [
            {
                type: "sunburst",
                ids,
                labels,
                parents,
                values,
                text,
                textinfo: "text",
                branchvalues: "total",
                marker: {
                    colors,
                    line: { color: "rgba(110, 92, 60, 0.2)", width: 1 }
                },
                hovertemplate: "%{label}<br>%{value:,.0f}<br>%{percentParent:.1%}<extra></extra>",
                insidetextorientation: "radial"
            }
        ],
        layout: {
            margin: { l: 10, r: 10, t: 8, b: 10 },
            paper_bgcolor: "rgba(0,0,0,0)",
            plot_bgcolor: "rgba(0,0,0,0)"
        },
        periodTransactions: [],
    };
}

function buildSunburstFigureFromTransactions(transactions: SpiirTransaction[], mode: SunburstMode, periods: string[]): SpiirSunburstFigure {
    const periodTransactions = [...filterTransactionsByPeriods(transactions, mode, periods)]
        .filter((transaction) => sunburstTransactionValue(transaction) > 0)
        .sort((left, right) => sunburstTransactionValue(right) - sunburstTransactionValue(left)
            || right.ymd.localeCompare(left.ymd)
            || compareLocale(left.description, right.description));

    const incomeTransactions = periodTransactions.filter((transaction) => transaction.categoryType === "Income" && Number(transaction.amount ?? 0) > 0);
    const refundTransactions = periodTransactions.filter((transaction) => transaction.categoryType === "Expense" && Number(transaction.amount ?? 0) > 0);
    const expenseTransactions = periodTransactions.filter((transaction) => transaction.categoryType === "Expense" && Number(transaction.amount ?? 0) < 0);

    const sumBy = (
        items: SpiirTransaction[],
        keyFn: (transaction: SpiirTransaction) => string,
        valueFn: (transaction: SpiirTransaction) => number
    ): Map<string, number> => {
        const map = new Map<string, number>();
        items.forEach((item) => {
            const key = keyFn(item);
            map.set(key, (map.get(key) ?? 0) + valueFn(item));
        });
        return map;
    };

    const incomeByMain = sumBy(
        incomeTransactions,
        (transaction) => normalizeLabel(transaction.mainCategoryName),
        (transaction) => Number(transaction.amount ?? 0)
    );
    const incomeBySub = sumBy(
        incomeTransactions,
        (transaction) => makePair(normalizeLabel(transaction.mainCategoryName), normalizeLabel(transaction.categoryName)),
        (transaction) => Number(transaction.amount ?? 0)
    );
    const expenseByMain = sumBy(
        expenseTransactions,
        (transaction) => normalizeLabel(transaction.mainCategoryName),
        (transaction) => -Number(transaction.amount ?? 0)
    );
    const expenseBySub = sumBy(
        expenseTransactions,
        (transaction) => makePair(normalizeLabel(transaction.mainCategoryName), normalizeLabel(transaction.categoryName)),
        (transaction) => -Number(transaction.amount ?? 0)
    );
    const refundBySub = sumBy(
        refundTransactions,
        (transaction) => {
            const main = normalizeLabel(transaction.mainCategoryName);
            const sub = normalizeLabel(transaction.categoryName);
            return makePair("Refunds", sunburstRefundLabel(main, sub));
        },
        (transaction) => Number(transaction.amount ?? 0)
    );

    const refundTotal = [...refundBySub.values()].reduce((sum, value) => sum + value, 0);
    if (refundTotal > 0) {
        incomeByMain.set("Refunds", refundTotal);
    }

    const sortEntries = (left: [string, number], right: [string, number]): number => right[1] - left[1] || compareLocale(left[0], right[0]);
    const incomeMainEntries = [...incomeByMain.entries()].filter(([, value]) => value > 0).sort(sortEntries);
    const expenseMainEntries = [...expenseByMain.entries()].filter(([, value]) => value > 0).sort(sortEntries);
    const incomeTotal = incomeMainEntries.reduce((sum, [, value]) => sum + value, 0);
    const expenseTotal = expenseMainEntries.reduce((sum, [, value]) => sum + value, 0);
    const savings = Math.max(0, incomeTotal - expenseTotal);
    const debt = Math.max(0, expenseTotal - incomeTotal);

    const ids: string[] = [];
    const labels: string[] = [];
    const parents: string[] = [];
    const values: number[] = [];
    const colors: string[] = [];
    const text: string[] = [];

    const add = (id: string, label: string, parent: string, value: number, color: string): void => {
        if (value <= 0) {
            return;
        }
        ids.push(id);
        labels.push(label);
        parents.push(parent);
        values.push(value);
        colors.push(color);
        text.push(`${label}<br>${formatCompact(value)}`);
    };

    const incomeRoot = "T|Income";
    const expenseRoot = "T|Expense";
    add(incomeRoot, "Income", "", incomeTotal, "rgba(31, 107, 92, 0.34)");
    add(expenseRoot, "Expense", "", expenseTotal, "rgba(142, 59, 46, 0.28)");

    incomeMainEntries.forEach(([main, value]) => {
        const mainId = `T|Income|${main}`;
        add(mainId, main, incomeRoot, value, incomePartColorFromHue(135 + (hash32(main) % 50), main, 0.66));
        const bySub = main === "Refunds" ? refundBySub : incomeBySub;
        [...bySub.entries()]
            .map(([key, total]) => ({ pair: splitPair(key), total }))
            .filter(({ pair, total }) => pair[0] === main && total > 0)
            .sort((left, right) => right.total - left.total || compareLocale(left.pair[1], right.pair[1]))
            .forEach(({ pair, total }) => add(`T|Income|${main}|${pair[1]}`, pair[1], mainId, total, incomePartColorFromHue(135 + (hash32(`${main}|${pair[1]}`) % 50), pair[1], 0.5)));
    });

    if (savings > 0) {
        add("T|Savings", "Savings", "", savings, "rgba(143, 122, 72, 0.28)");
    }

    expenseMainEntries.forEach(([main, value]) => {
        const mainId = `T|Expense|${main}`;
        const hue = hash32(main) % 360;
        add(mainId, main, expenseRoot, value, expenseMainColorFromHue(hue, 0.66, 60));
        [...expenseBySub.entries()]
            .map(([key, total]) => ({ pair: splitPair(key), total }))
            .filter(({ pair, total }) => pair[0] === main && total > 0)
            .sort((left, right) => right.total - left.total || compareLocale(left.pair[1], right.pair[1]))
            .forEach(({ pair, total }) => add(`T|Expense|${main}|${pair[1]}`, pair[1], mainId, total, expenseSubColorFromHue(hue, pair[1], 0.5)));
    });

    if (debt > 0) {
        add("T|Debt", "Debt", "", debt, "rgba(142, 59, 46, 0.22)");
    }

    const parentIds = new Set(ids);
    periodTransactions.forEach((transaction, index) => {
        const parentId = sunburstTransactionParentId(transaction);
        if (!parentId || !parentIds.has(parentId)) {
            return;
        }
        add(`P|${index}`, sunburstTransactionLabel(transaction), parentId, sunburstTransactionValue(transaction), sunburstTransactionColor(transaction));
    });

    return {
        data: [
            {
                type: "sunburst",
                ids,
                labels,
                parents,
                values,
                text,
                textinfo: "text",
                branchvalues: "total",
                marker: {
                    colors,
                    line: { color: "rgba(110, 92, 60, 0.2)", width: 1 }
                },
                hovertemplate: "%{label}<br>%{value:,.0f}<br>%{percentParent:.1%}<extra></extra>",
                insidetextorientation: "radial"
            }
        ],
        layout: {
            margin: { l: 10, r: 10, t: 8, b: 10 },
            paper_bgcolor: "rgba(0,0,0,0)",
            plot_bgcolor: "rgba(0,0,0,0)"
        },
        periodTransactions,
    };
}

function buildSunburstFigure(
    rows: SpiirOverviewRow[],
    transactions: SpiirTransaction[] | null,
    mode: SunburstMode,
    periods: string[],
    includePosts: boolean
): SpiirSunburstFigure {
    if (includePosts && transactions) {
        return buildSunburstFigureFromTransactions(transactions, mode, periods);
    }
    return buildSunburstFigureFromRows(rows, periods);
}

export default function SpiirSunburstModal({
    state,
    transactions = null,
    closeOnEscape = true,
    allowPosts = true,
    ensureTransactionsLoaded,
    onClose,
    onOpenTransactions
}: SpiirSunburstModalProps) {
    const [graphDiv, setGraphDiv] = useState<PlotlyGraphDiv | null>(null);
    const [showPosts, setShowPosts] = useState(false);
    const [postsLoading, setPostsLoading] = useState(false);
    const figure = useMemo(
        () => buildSunburstFigure(state.rows, showPosts ? transactions : null, state.mode, state.periods, showPosts),
        [showPosts, state, transactions]
    );

    useEffect(() => {
        if (!closeOnEscape) {
            return;
        }
        const handleKeyDown = (event: KeyboardEvent): void => {
            if (event.key !== "Escape") {
                return;
            }
            event.preventDefault();
            onClose();
        };
        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [closeOnEscape, onClose]);

    useEffect(() => {
        setGraphDiv(null);
        setShowPosts(false);
        setPostsLoading(false);
    }, [state]);

    async function handleTogglePosts(): Promise<void> {
        if (!allowPosts || !ensureTransactionsLoaded) {
            return;
        }
        if (showPosts) {
            setShowPosts(false);
            return;
        }
        if (transactions !== null) {
            setShowPosts(true);
            return;
        }
        setPostsLoading(true);
        try {
            await ensureTransactionsLoaded();
            setShowPosts(true);
        } catch {
            // caller surfaces load errors
        } finally {
            setPostsLoading(false);
        }
    }

    function captureGraphDiv(_figure: unknown, nextGraphDiv: unknown): void {
        const next = nextGraphDiv as PlotlyGraphDiv | null;
        setGraphDiv((current) => current === next ? current : next);
    }

    useEffect(() => {
        if (!graphDiv || !figure || !state || !onOpenTransactions) {
            return;
        }

        const handleSunburstClick = (event: any): void => {
            void (async () => {
                const id = event.points?.[0]?.id;
                if (!id) {
                    return;
                }

                if (String(id).startsWith("P|")) {
                    const index = Number.parseInt(String(id).slice(2), 10);
                    const transaction = figure.periodTransactions[index];
                    if (!transaction) {
                        return;
                    }
                    onOpenTransactions(`${transaction.description || transaction.categoryName || "Post"} · ${sunburstTitle(state.mode, state.periods)}`, [transaction]);
                    return;
                }

                const shiftKey = Boolean(event.event?.shiftKey);
                if (!shiftKey && sunburstIdHasChildren(figure, String(id))) {
                    return;
                }
                const filter = sunburstFilterFromId(String(id));
                if (!filter) {
                    return;
                }

                let base = figure.periodTransactions;
                if (base.length === 0 && ensureTransactionsLoaded) {
                    try {
                        base = filterTransactionsByPeriods(await ensureTransactionsLoaded(), state.mode, state.periods);
                    } catch {
                        return;
                    }
                }

                if (base.length > 0) {
                    onOpenTransactions(`${filter.label} · ${sunburstTitle(state.mode, state.periods)}`, base.filter(filter.match));
                }
            })();
        };

        if (typeof graphDiv.on !== "function") {
            return;
        }

        graphDiv.on("plotly_click", handleSunburstClick);
        return () => {
            if (typeof graphDiv.removeListener === "function") {
                graphDiv.removeListener("plotly_click", handleSunburstClick);
            }
        };
    }, [ensureTransactionsLoaded, figure, graphDiv, onOpenTransactions, state]);

    return (
        <div className="modal-backdrop" onClick={onClose}>
            <section className="spiir-transactions-modal spiir-sunburst-modal" onClick={(event) => event.stopPropagation()}>
                <div className="panel-header compact-header">
                    <div>
                        <p className="eyebrow">Spiir</p>
                        <h2>{state.title}</h2>
                    </div>
                    <div className="spiir-sunburst-header-actions">
                        {allowPosts ? (
                            <button
                                type="button"
                                className={showPosts ? "spiir-pill-toggle active" : "spiir-pill-toggle"}
                                aria-pressed={showPosts}
                                onClick={() => void handleTogglePosts()}
                                disabled={postsLoading}
                            >
                                {postsLoading ? "Poster..." : "Vis poster"}
                            </button>
                        ) : null}
                        <button type="button" className="secondary-button" onClick={onClose}>
                            Luk
                        </button>
                    </div>
                </div>
                <Plot
                    data={figure.data as never[]}
                    layout={figure.layout as never}
                    config={{ displayModeBar: false, responsive: true }}
                    useResizeHandler
                    style={{ width: "100%", height: "100%" }}
                    className="spiir-plot spiir-sunburst-plot"
                    onInitialized={captureGraphDiv}
                    onUpdate={captureGraphDiv}
                />
            </section>
        </div>
    );
}
