import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Plot from "react-plotly.js";

import {
    getCachedSpiirData,
    getSpiirOverview,
    getSpiirStatus,
    getSpiirTransactions,
    rebuildSpiirFromLocal,
    scheduleSpiirRebuildFromLocal
} from "./api";
import NordeaDashboard, { type NordeaDrilldownFilter } from "./NordeaDashboard";
import SpiirSunburstModal, { expenseMainColorFromHue, expenseSubColorFromHue, incomePartColorFromHue, type SunburstMode, type SunburstState } from "./SpiirSunburstModal";
import type {
    NordeaCategoryOption,
    SpiirOverviewResponse,
    SpiirOverviewRow,
    SpiirStatusResponse,
    SpiirTransaction
} from "./types";

type SpiirTab = "monthly" | "yearly";
type PeriodKind = "month" | "year";
type ChartLevel = "top" | "main" | "sub";

type ChartOptions = {
    show: boolean;
    cumulative: boolean;
    stacked: boolean;
    bars: boolean;
    level: ChartLevel;
};

type NordeaDrilldownModalState = NordeaDrilldownFilter | null;

type ChartSeries = {
    key: string;
    label: string;
    kind: "income" | "income_part" | "diff" | "expense" | "expense_total";
    y: number[];
    main: string;
    incomeHue?: number;
    expenseHue?: number;
};

const EXPENSE_MAIN_HUES = [190, 205, 220, 235, 250, 265, 280, 295, 310, 325, 340];
const INCOME_PART_HUES = [108, 118, 128, 138, 148, 158, 168];
const MONTH_WINDOW_OPTIONS = [
    { value: "3", label: "3 mdr" },
    { value: "6", label: "6 mdr" },
    { value: "12", label: "12 mdr" },
    { value: "24", label: "24 mdr" },
    { value: "all", label: "Alle" }
];
const YEAR_WINDOW_OPTIONS = [
    { value: "3", label: "3 år" },
    { value: "5", label: "5 år" },
    { value: "10", label: "10 år" },
    { value: "all", label: "Alle" }
];

function readStoredString(key: string, fallback: string): string {
    try {
        return window.localStorage.getItem(key) ?? fallback;
    } catch {
        return fallback;
    }
}

function readStoredBool(key: string, fallback: boolean): boolean {
    return readStoredString(key, fallback ? "1" : "0") === "1";
}

function storeString(key: string, value: string): void {
    try {
        window.localStorage.setItem(key, value);
    } catch {
        // ignore storage failures
    }
}

function storeBool(key: string, value: boolean): void {
    storeString(key, value ? "1" : "0");
}

function formatNumber(value: number | null | undefined): string {
    if (value === null || value === undefined || Number.isNaN(value)) {
        return "";
    }
    return new Intl.NumberFormat("da-DK", { maximumFractionDigits: 0 }).format(value);
}

function hasChildren(rows: SpiirOverviewRow[], key: string): boolean {
    return rows.some((row) => row.parent === key);
}

function TogglePill({ label, active, onClick, disabled = false }: { label: string; active: boolean; onClick: () => void; disabled?: boolean }) {
    return (
        <button
            type="button"
            className={active ? "spiir-pill-toggle active" : "spiir-pill-toggle"}
            aria-pressed={active}
            onClick={onClick}
            disabled={disabled}
        >
            {label}
        </button>
    );
}

function valueToneClass(value: number | null | undefined): string {
    if (value === null || value === undefined || Number.isNaN(value) || value === 0) {
        return "spiir-neutral";
    }
    return value > 0 ? "spiir-positive" : "spiir-negative";
}

function slicePeriods(periods: string[], count: number): string[] {
    if (count <= 0 || periods.length <= count) {
        return periods;
    }
    return periods.slice(-count);
}

function visibleMonthPeriods(periods: string[], selection: string, excludeLatest: boolean): string[] {
    const skipLast = excludeLatest ? 1 : 0;
    const lastOverall = periods[periods.length - 1];
    if (selection.startsWith("y:")) {
        let next = periods.filter((period) => period.startsWith(`${selection.slice(2)}-`));
        if (skipLast && next.length > 0 && next[next.length - 1] === lastOverall) {
            next = next.slice(0, -1);
        }
        return next;
    }
    if (selection === "all") {
        return skipLast ? periods.slice(0, Math.max(0, periods.length - 1)) : periods;
    }
    const count = Number.parseInt(selection, 10) || 12;
    const next = slicePeriods(periods, count + skipLast);
    return skipLast ? next.slice(0, Math.max(0, next.length - 1)) : next;
}

function visibleYearPeriods(periods: string[], selection: string, excludeLatest: boolean): string[] {
    const base = excludeLatest ? periods.slice(0, Math.max(0, periods.length - 1)) : periods;
    if (selection === "all") {
        return base;
    }
    const count = Number.parseInt(selection, 10) || base.length;
    return base.slice(-count);
}

function previousWindow(allPeriods: string[], visiblePeriods: string[]): string[] {
    if (visiblePeriods.length === 0) {
        return [];
    }
    const firstIndex = allPeriods.indexOf(visiblePeriods[0]);
    if (firstIndex < visiblePeriods.length) {
        return [];
    }
    return allPeriods.slice(firstIndex - visiblePeriods.length, firstIndex);
}

function rowTotalForPeriods(row: SpiirOverviewRow, periods: string[]): number {
    return periods.reduce((sum, period) => sum + Number(row.values[period] ?? 0), 0);
}

function rowAvgForPeriods(row: SpiirOverviewRow, periods: string[]): number {
    if (periods.length === 0) {
        return 0;
    }
    return Math.round(rowTotalForPeriods(row, periods) / periods.length);
}

function rowHasNonZeroForPeriods(row: SpiirOverviewRow, periods: string[]): boolean {
    return periods.some((period) => Number(row.values[period] ?? 0) !== 0);
}

function signedSortValue(left: number, right: number): number {
    const leftPositive = left > 0;
    const rightPositive = right > 0;
    if (leftPositive && rightPositive) {
        return right - left;
    }
    if (leftPositive && !rightPositive) {
        return -1;
    }
    if (!leftPositive && rightPositive) {
        return 1;
    }
    return left - right;
}

function compareLocale(left: string | null | undefined, right: string | null | undefined): number {
    return String(left ?? "").localeCompare(String(right ?? ""), "da");
}

function absTotalForPeriods(row: SpiirOverviewRow, periods: string[]): number {
    return Math.abs(rowTotalForPeriods(row, periods));
}

function filterVisibleHierarchy(rows: SpiirOverviewRow[], periods: string[]): SpiirOverviewRow[] {
    const byKey = new Map(rows.map((row) => [row.key, row]));
    const keep = new Set<string>();
    const alwaysKeep = new Set(["diff", "income", "expense", "hashtag"]);

    const markKeep = (row: SpiirOverviewRow): void => {
        let current: SpiirOverviewRow | undefined = row;
        while (current) {
            if (keep.has(current.key)) {
                return;
            }
            keep.add(current.key);
            current = current.parent ? byKey.get(current.parent) : undefined;
        }
    };

    rows.forEach((row) => {
        if (alwaysKeep.has(row.key) || rowHasNonZeroForPeriods(row, periods)) {
            markKeep(row);
        }
    });

    return rows.filter((row) => keep.has(row.key));
}

function sortHierarchyRows(
    rows: SpiirOverviewRow[],
    periods: string[],
    compareChildren: (left: SpiirOverviewRow, right: SpiirOverviewRow) => number
): SpiirOverviewRow[] {
    const filteredRows = filterVisibleHierarchy(rows, periods);
    const byParent = new Map<string | null, SpiirOverviewRow[]>();
    filteredRows.forEach((row) => {
        const parentKey = row.parent ?? null;
        const current = byParent.get(parentKey) ?? [];
        current.push(row);
        byParent.set(parentKey, current);
    });

    const rootOrder = new Map([
        ["diff", 0],
        ["income", 1],
        ["expense", 2],
        ["hashtag", 3]
    ]);

    const sortSiblings = (siblings: SpiirOverviewRow[], parentKey: string | null): SpiirOverviewRow[] => {
        if (parentKey === null) {
            return [...siblings].sort((left, right) => {
                const leftOrder = rootOrder.get(left.key);
                const rightOrder = rootOrder.get(right.key);
                if (leftOrder !== undefined || rightOrder !== undefined) {
                    return (leftOrder ?? Number.MAX_SAFE_INTEGER) - (rightOrder ?? Number.MAX_SAFE_INTEGER);
                }
                return compareLocale(left.label, right.label);
            });
        }
        return [...siblings].sort(compareChildren);
    };

    const flatten = (parentKey: string | null): SpiirOverviewRow[] => {
        const siblings = sortSiblings(byParent.get(parentKey) ?? [], parentKey);
        return siblings.flatMap((row) => [row, ...flatten(row.key)]);
    };

    return flatten(null);
}

function sortOverviewRowsWithTotals(
    rows: SpiirOverviewRow[],
    periods: string[],
    totalSort: boolean
): SpiirOverviewRow[] {
    if (!totalSort) {
        return sortHierarchyRows(rows, periods, (left, right) => compareLocale(left.label, right.label));
    }

    const filteredRows = filterVisibleHierarchy(rows, periods);
    const topRows = filteredRows.filter((row) => row.key === "diff" || row.key === "income" || row.key === "expense");
    const hashtagRow = filteredRows.find((row) => row.key === "hashtag") ?? null;
    const compareByAbsTotal = (left: SpiirOverviewRow, right: SpiirOverviewRow): number => {
        const diff = absTotalForPeriods(right, periods) - absTotalForPeriods(left, periods);
        if (diff !== 0) {
            return diff;
        }
        return compareLocale(left.label, right.label);
    };

    const incomeChildren = filteredRows
        .filter((row) => row.parent === "income")
        .sort(compareByAbsTotal);

    const expenseChildren = filteredRows
        .filter((row) => row.kind === "sub" && row.level === 2)
        .map((row) => ({ ...row, parent: "expense" }))
        .sort(compareByAbsTotal);

    const hashtagChildren = filteredRows
        .filter((row) => row.parent === "hashtag")
        .sort(compareByAbsTotal);

    const nextRows: SpiirOverviewRow[] = [];
    const diffRow = topRows.find((row) => row.key === "diff");
    const incomeRow = topRows.find((row) => row.key === "income");
    const expenseRow = topRows.find((row) => row.key === "expense");

    if (diffRow) {
        nextRows.push(diffRow);
    }
    if (incomeRow) {
        nextRows.push(incomeRow);
    }
    nextRows.push(...incomeChildren);
    if (expenseRow) {
        nextRows.push(expenseRow);
    }
    nextRows.push(...expenseChildren);
    if (hashtagRow && hashtagChildren.length > 0) {
        nextRows.push(hashtagRow);
        nextRows.push(...hashtagChildren);
    }

    return nextRows;
}

function buildVisibleRows(rows: SpiirOverviewRow[], expandedRows: Set<string>): SpiirOverviewRow[] {
    const byKey = new Map(rows.map((row) => [row.key, row]));
    return rows.filter((row) => {
        if (!row.parent) {
            return true;
        }
        let parentKey: string | null = row.parent;
        while (parentKey) {
            if (!expandedRows.has(parentKey)) {
                return false;
            }
            parentKey = byKey.get(parentKey)?.parent ?? null;
        }
        return true;
    });
}

function buildHeatmapScale(rows: SpiirOverviewRow[], periods: string[]): Map<string, { pos: number; neg: number }> {
    const scale = new Map<string, { pos: number; neg: number }>();
    rows.forEach((row) => {
        if (row.level !== 2 || !row.parent) {
            return;
        }
        const current = scale.get(row.parent) ?? { pos: 0, neg: 0 };
        periods.forEach((period) => {
            const value = Number(row.values[period] ?? 0);
            if (value > 0) {
                current.pos = Math.max(current.pos, value);
            }
            if (value < 0) {
                current.neg = Math.max(current.neg, Math.abs(value));
            }
        });
        scale.set(row.parent, current);
    });
    return scale;
}

function heatmapCellStyle(
    row: SpiirOverviewRow,
    value: number,
    heatmap: boolean,
    scale: Map<string, { pos: number; neg: number }>
): React.CSSProperties | undefined {
    if (!heatmap || row.level !== 2 || !row.parent || value === 0) {
        return undefined;
    }
    const current = scale.get(row.parent);
    if (!current) {
        return undefined;
    }
    const divisor = value > 0 ? current.pos : current.neg;
    if (!divisor) {
        return undefined;
    }
    const alpha = Math.abs(value) / divisor * 0.24;
    const rgb = value > 0 ? "31, 107, 92" : "142, 59, 46";
    return { background: `rgba(${rgb}, ${Math.min(0.24, alpha)})` };
}

function buildPeriodChartSeries(visiblePeriods: string[], rows: SpiirOverviewRow[], level: ChartLevel): ChartSeries[] {
    const byKey = new Map(rows.map((row) => [row.key, row]));
    const getY = (row: SpiirOverviewRow | undefined): number[] => visiblePeriods.map((period) => Number(row?.values[period] ?? 0));
    const sumY = (values: number[]): number => values.reduce((sum, value) => sum + value, 0);
    const hasNonZero = (values: number[]): boolean => values.some((value) => value !== 0);
    const output: ChartSeries[] = [];
    const incomeRow = byKey.get("income");
    const expenseRow = byKey.get("expense");
    const diffRow = byKey.get("diff");

    if (level === "top") {
        return [
            { key: "income", label: "Income", kind: "income", y: getY(incomeRow), main: "" },
            { key: "expense", label: "Expense", kind: "expense_total", y: getY(expenseRow), main: "" },
            { key: "diff", label: "Diff", kind: "diff", y: getY(diffRow), main: "" }
        ];
    }

    const incomeParts = rows
        .filter((row) => row.kind === "sub" && row.parent === "income" && row.level === 1)
        .map((row) => ({ row, y: getY(row) }))
        .filter(({ y }) => hasNonZero(y))
        .map(({ row, y }) => ({
            key: row.key,
            label: row.label,
            kind: "income_part" as const,
            y,
            main: row.label,
            signed: sumY(y),
            absTotal: Math.abs(sumY(y))
        }))
        .sort((left, right) => signedSortValue(right.signed, left.signed) || right.absTotal - left.absTotal || compareLocale(left.label, right.label));

    if (incomeParts.length > 0) {
        const labels = incomeParts.map((part) => String(part.label)).sort(compareLocale);
        const hueByLabel = new Map(labels.map((label, index) => [label, INCOME_PART_HUES[index % INCOME_PART_HUES.length]]));
        incomeParts.forEach((part) => output.push({
            key: part.key,
            label: part.label,
            kind: part.kind,
            y: part.y,
            main: part.main,
            incomeHue: hueByLabel.get(String(part.label))
        }));
    } else {
        output.push({ key: "income", label: "Income", kind: "income", y: getY(incomeRow), main: "" });
    }

    const entries = rows
        .filter((row) => level === "main"
            ? row.kind === "main" && row.level === 1 && row.parent === "expense"
            : row.kind === "sub" && row.level === 2)
        .map((row) => ({
            row,
            y: getY(row),
            main: row.mainCategoryName || row.label,
            signed: sumY(getY(row)),
            absTotal: Math.abs(sumY(getY(row)))
        }))
        .filter(({ y }) => hasNonZero(y))
        .sort((left, right) => signedSortValue(right.signed, left.signed) || right.absTotal - left.absTotal || compareLocale(left.row.label, right.row.label));

    const mains = [...new Set(entries.map((entry) => String(entry.main)).filter(Boolean))].sort(compareLocale);
    const mainHue = new Map(mains.map((main, index) => [main, EXPENSE_MAIN_HUES[index % EXPENSE_MAIN_HUES.length]]));
    entries.forEach((entry) => output.push({
        key: entry.row.key,
        label: entry.row.label,
        kind: "expense",
        y: entry.y,
        main: entry.main,
        expenseHue: mainHue.get(String(entry.main))
    }));

    return output;
}

function buildPeriodChartFigure(
    section: SpiirOverviewResponse["monthly"] | SpiirOverviewResponse["yearly"],
    visiblePeriods: string[],
    periodKind: PeriodKind,
    options: ChartOptions
): { data: object[]; layout: object } {
    const series = buildPeriodChartSeries(visiblePeriods, section.rows, options.level);
    const accumulate = (values: number[]): number[] => {
        let running = 0;
        return values.map((value) => {
            running += value;
            return running;
        });
    };

    const traces = series.map((entry) => {
        const y = options.cumulative ? accumulate(entry.y) : entry.y;
        const isIncome = entry.kind === "income";
        const isIncomePart = entry.kind === "income_part";
        const isDiff = entry.kind === "diff";
        const isExpense = entry.kind === "expense" || entry.kind === "expense_total";

        let color = "rgba(143, 122, 72, 0.9)";
        if (isIncome) {
            color = "rgba(31, 107, 92, 0.9)";
        } else if (isIncomePart) {
            color = incomePartColorFromHue(Number(entry.incomeHue ?? INCOME_PART_HUES[0]), entry.label, 0.86);
        } else if (isDiff) {
            color = "rgba(143, 122, 72, 0.95)";
        } else if (entry.kind === "expense_total") {
            color = "rgba(142, 59, 46, 0.88)";
        } else if (options.level === "main") {
            color = expenseMainColorFromHue(Number(entry.expenseHue ?? EXPENSE_MAIN_HUES[0]), 0.84, 60);
        } else {
            color = expenseSubColorFromHue(Number(entry.expenseHue ?? EXPENSE_MAIN_HUES[0]), entry.label, 0.76);
        }

        if (options.bars) {
            return {
                type: "bar",
                name: entry.label,
                x: visiblePeriods,
                y,
                marker: { color, line: { color: "rgba(255,255,255,0.2)", width: 1 } },
                hovertemplate: "%{fullData.name} | %{y:,.0f}<extra></extra>"
            };
        }

        const doStackExpenses = options.stacked && isExpense && !isDiff && entry.kind !== "expense_total" && options.level !== "top";
        const doStackIncome = options.stacked && isIncomePart && options.level !== "top";
        return {
            type: "scatter",
            mode: "lines+markers",
            name: entry.label,
            x: visiblePeriods,
            y,
            line: { color, width: isDiff ? 3.2 : 2.6 },
            marker: { color, size: 7 },
            stackgroup: doStackExpenses ? "exp" : doStackIncome ? "inc" : undefined,
            fill: doStackExpenses || doStackIncome ? "tonexty" : "none",
            hovertemplate: "%{fullData.name} | %{y:,.0f}<extra></extra>"
        };
    });

    return {
        data: traces,
        layout: {
            title: {
                text: periodKind === "year"
                    ? `År: ${visiblePeriods[0] ?? ""}-${visiblePeriods[visiblePeriods.length - 1] ?? ""}`
                    : `Måneder: ${visiblePeriods[0] ?? ""}-${visiblePeriods[visiblePeriods.length - 1] ?? ""}`,
                font: { size: 13 }
            },
            margin: { l: 64, r: 12, t: 42, b: 66 },
            height: 520,
            showlegend: true,
            legend: { orientation: "h", x: 0, xanchor: "left", y: -0.22, yanchor: "top" },
            hovermode: "x unified",
            barmode: options.bars && options.stacked && options.level !== "top" ? "relative" : options.bars ? "group" : undefined,
            bargap: options.bars ? 0.18 : undefined,
            xaxis: {
                tickangle: 0,
                automargin: true,
                tickmode: "array",
                tickvals: periodKind === "month" && visiblePeriods.length > 10
                    ? visiblePeriods.filter((_, index) => index % 2 === 0 || index === visiblePeriods.length - 1)
                    : visiblePeriods
            },
            yaxis: {
                rangemode: "tozero",
                automargin: true,
                tickformat: ",.0f"
            },
            paper_bgcolor: "rgba(0,0,0,0)",
            plot_bgcolor: "rgba(255,255,255,0.55)"
        }
    };
}

function monthEndDate(month: string): string {
    const [year, monthNumber] = month.split("-").map((part) => Number(part));
    const day = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
    return `${month}-${String(day).padStart(2, "0")}`;
}

function periodFilterForDrilldown(periods: string[], kind: PeriodKind): Pick<NordeaDrilldownFilter, "periodFilter" | "periodStart" | "periodEnd"> {
    if (periods.length === 1) {
        return { periodFilter: kind === "year" ? `year:${periods[0]}` : `month:${periods[0]}` };
    }
    const sortedPeriods = [...periods].sort();
    const firstPeriod = sortedPeriods[0];
    const lastPeriod = sortedPeriods[sortedPeriods.length - 1];
    if (kind === "year") {
        return { periodFilter: "custom", periodStart: `${firstPeriod}-01-01`, periodEnd: `${lastPeriod}-12-31` };
    }
    return { periodFilter: "custom", periodStart: `${firstPeriod}-01`, periodEnd: monthEndDate(lastPeriod) };
}

function categoryOptionFromOverviewRow(row: SpiirOverviewRow): NordeaCategoryOption | null {
    if (row.kind === "sub" && row.categoryId !== null && row.categoryId !== undefined) {
        return {
            categoryType: row.categoryType || "Expense",
            mainCategoryId: row.mainCategoryId ?? "",
            mainCategoryName: row.mainCategoryName || "Diverse",
            categoryId: row.categoryId,
            categoryName: row.categoryName || row.label,
            usage_count: 0,
        };
    }
    if (row.kind === "main" && row.mainCategoryId !== null && row.mainCategoryId !== undefined) {
        return {
            categoryType: row.categoryType || "Expense",
            mainCategoryId: row.mainCategoryId,
            mainCategoryName: row.mainCategoryName || row.label,
            categoryId: `__main__::${String(row.mainCategoryId)}`,
            categoryName: row.mainCategoryName || row.label,
            usage_count: 0,
        };
    }
    return null;
}

function drilldownFilterFromOverviewRow(row: SpiirOverviewRow, periods: string[], kind: PeriodKind): NordeaDrilldownFilter {
    const categoryFilter = categoryOptionFromOverviewRow(row);
    const period = periodFilterForDrilldown(periods, kind);
    if (row.kind === "income") {
        return { title: "", ...period, visibilityFilter: "income", categoryFilter: null };
    }
    if (row.kind === "expense") {
        return { title: "", ...period, visibilityFilter: "expense", categoryFilter: null };
    }
    if (row.kind === "hashtag_item" && row.hashtag) {
        return { title: "", ...period, visibilityFilter: "all", categoryFilter: null, searchText: String(row.hashtag) };
    }
    if (row.kind === "hashtag") {
        return { title: "", ...period, visibilityFilter: "all", categoryFilter: null, searchText: "#" };
    }
    return {
        title: "",
        ...period,
        visibilityFilter: categoryFilter ? "category" : row.kind === "expense" ? "consumption" : "all",
        categoryFilter,
    };
}

function categoryOptionFromTransactions(items: SpiirTransaction[]): NordeaCategoryOption | null {
    const first = items[0];
    if (!first || first.categoryId === null || first.categoryId === undefined) {
        return null;
    }
    const sameCategory = items.every((item) => String(item.categoryId ?? "") === String(first.categoryId ?? "") && String(item.mainCategoryId ?? "") === String(first.mainCategoryId ?? ""));
    if (!sameCategory) {
        return null;
    }
    return {
        categoryType: first.categoryType || "Expense",
        mainCategoryId: first.mainCategoryId ?? "",
        mainCategoryName: first.mainCategoryName || "Diverse",
        categoryId: first.categoryId,
        categoryName: first.categoryName || "Ikke kategoriseret",
        usage_count: 0,
    };
}

function periodFilterFromTransactions(items: SpiirTransaction[]): NordeaDrilldownFilter["periodFilter"] {
    const months = [...new Set(items.map((item) => item.yyyymm).filter(Boolean))];
    if (months.length === 1) {
        return `month:${months[0]}`;
    }
    const years = [...new Set(items.map((item) => item.year).filter(Boolean))];
    return years.length === 1 ? `year:${years[0]}` : "all";
}

type OverviewSectionProps = {
    title: string;
    section: SpiirOverviewResponse["monthly"] | SpiirOverviewResponse["yearly"];
    periodKind: PeriodKind;
    visiblePeriods: string[];
    prevPeriods: string[];
    expandedRows: Set<string>;
    onToggle: (key: string) => void;
    onExpandAll: () => void;
    onCollapseAll: () => void;
    totalSort: boolean;
    heatmap: boolean;
    showPrevTotals: boolean;
    onOpenDrilldown: (row: SpiirOverviewRow, title: string, periods: string[], kind: PeriodKind) => void;
    onOpenSunburst: (title: string, periods: string[], mode: SunburstMode, rows: SpiirOverviewRow[]) => void;
};

function OverviewSection({
    title,
    section,
    periodKind,
    visiblePeriods,
    prevPeriods,
    expandedRows,
    onToggle,
    onExpandAll,
    onCollapseAll,
    totalSort,
    heatmap,
    showPrevTotals,
    onOpenDrilldown,
    onOpenSunburst
}: OverviewSectionProps) {
    const orderedRows = useMemo(
        () => sortOverviewRowsWithTotals(section.rows, visiblePeriods, totalSort),
        [section.rows, totalSort, visiblePeriods]
    );
    const visibleRows = useMemo(() => buildVisibleRows(orderedRows, expandedRows), [expandedRows, orderedRows]);
    const heatmapScale = useMemo(() => buildHeatmapScale(orderedRows, visiblePeriods), [orderedRows, visiblePeriods]);
    const expandableKeys = useMemo(
        () => orderedRows.filter((row) => hasChildren(orderedRows, row.key)).map((row) => row.key),
        [orderedRows]
    );
    const allExpanded = expandableKeys.length > 0 && expandableKeys.every((key) => expandedRows.has(key));

    return (
        <section className="panel spiir-panel">
            <div className="spiir-table-scroll">
                <table className="spiir-table">
                    <thead>
                        <tr>
                            <th className="spiir-sticky">
                                <button
                                    type="button"
                                    className="spiir-pill-toggle spiir-table-expand-pill"
                                    onClick={allExpanded ? onCollapseAll : onExpandAll}
                                >
                                    {allExpanded ? "Collapse" : "Expand"}
                                </button>
                            </th>
                            {visiblePeriods.map((period) => (
                                <th key={period}>
                                    <button
                                        type="button"
                                        className="spiir-th-button"
                                        onClick={() => onOpenSunburst(`${title} · ${period}`, [period], periodKind === "year" ? "years" : "months", section.rows)}
                                    >
                                        {period}
                                    </button>
                                </th>
                            ))}
                            <th>
                                <button
                                    type="button"
                                    className="spiir-th-button spiir-th-button-right"
                                    onClick={() => onOpenSunburst(`${title} · Total`, visiblePeriods, periodKind === "year" ? "years" : "months", section.rows)}
                                >
                                    I alt
                                </button>
                            </th>
                            <th>Snit</th>
                            {showPrevTotals ? <th>Prev total</th> : null}
                            {showPrevTotals ? <th>Δ total</th> : null}
                        </tr>
                    </thead>
                    <tbody>
                        {visibleRows.map((row) => {
                            const expandable = hasChildren(orderedRows, row.key);
                            const total = rowTotalForPeriods(row, visiblePeriods);
                            const avg = rowAvgForPeriods(row, visiblePeriods);
                            const prevTotal = rowTotalForPeriods(row, prevPeriods);
                            const delta = total - prevTotal;
                            return (
                                <tr key={row.key} className={`spiir-row spiir-level-${row.level}`}>
                                    <td className="spiir-sticky spiir-label-cell">
                                        <div className="spiir-label-wrap">
                                            {expandable ? (
                                                <button type="button" className="spiir-expand-toggle" onClick={() => onToggle(row.key)}>
                                                    {expandedRows.has(row.key) ? "−" : "+"}
                                                </button>
                                            ) : null}
                                            <span className="spiir-label-text" title={row.label}>{row.label}</span>
                                        </div>
                                    </td>
                                    {visiblePeriods.map((period) => {
                                        const value = Number(row.values[period] ?? 0);
                                        return (
                                            <td key={`${row.key}-${period}`} style={heatmapCellStyle(row, value, heatmap, heatmapScale)}>
                                                <button
                                                    type="button"
                                                    className={`spiir-cell-button ${valueToneClass(value)}`}
                                                    onClick={() => onOpenDrilldown(row, `${row.label} · ${period}`, [period], periodKind)}
                                                >
                                                    {formatNumber(value)}
                                                </button>
                                            </td>
                                        );
                                    })}
                                    <td>
                                        <button
                                            type="button"
                                            className={`spiir-cell-button spiir-cell-button-right ${valueToneClass(total)}`}
                                            onClick={() => onOpenDrilldown(row, `${row.label} · ${visiblePeriods[0]}-${visiblePeriods[visiblePeriods.length - 1]}`, visiblePeriods, periodKind)}
                                        >
                                            {formatNumber(total)}
                                        </button>
                                    </td>
                                    <td className="spiir-muted-cell">{formatNumber(avg)}</td>
                                    {showPrevTotals ? (
                                        <td>
                                            {prevPeriods.length > 0 ? (
                                                <button
                                                    type="button"
                                                    className="spiir-cell-button spiir-cell-button-right spiir-muted-cell"
                                                    onClick={() => onOpenDrilldown(row, `${row.label} · ${prevPeriods[0]}-${prevPeriods[prevPeriods.length - 1]}`, prevPeriods, periodKind)}
                                                >
                                                    {formatNumber(prevTotal)}
                                                </button>
                                            ) : (
                                                <span className="spiir-muted-cell">-</span>
                                            )}
                                        </td>
                                    ) : null}
                                    {showPrevTotals ? (
                                        <td>
                                            {prevPeriods.length > 0 ? (
                                                <button
                                                    type="button"
                                                    className={`spiir-cell-button spiir-cell-button-right ${valueToneClass(delta)}`}
                                                    onClick={() => onOpenDrilldown(row, `${row.label} · Delta`, visiblePeriods, periodKind)}
                                                >
                                                    {formatNumber(delta)}
                                                </button>
                                            ) : (
                                                <span className="spiir-muted-cell">-</span>
                                            )}
                                        </td>
                                    ) : null}
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </section>
    );
}

export default function SpiirDashboard({ active }: { active: boolean }) {
    const [status, setStatus] = useState<SpiirStatusResponse | null>(() => getCachedSpiirData().status);
    const [overview, setOverview] = useState<SpiirOverviewResponse | null>(() => getCachedSpiirData().overview);
    const [transactions, setTransactions] = useState<SpiirTransaction[] | null>(() => getCachedSpiirData().transactions);
    const backgroundRefreshIdRef = useRef(0);
    const [toolbarHost, setToolbarHost] = useState<HTMLElement | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [tab, setTab] = useState<SpiirTab>("monthly");
    const [expandedMonthlyRows, setExpandedMonthlyRows] = useState<Set<string>>(new Set(["income", "expense", "hashtag"]));
    const [expandedYearlyRows, setExpandedYearlyRows] = useState<Set<string>>(new Set(["income", "expense", "hashtag"]));
    const [nordeaDrilldownModal, setNordeaDrilldownModal] = useState<NordeaDrilldownModalState>(null);
    const [sunburstState, setSunburstState] = useState<SunburstState>(null);
    const [monthWindow, setMonthWindow] = useState(() => readStoredString("spiir_monthCount", "12"));
    const [yearWindow, setYearWindow] = useState(() => readStoredString("spiir_yearCount", "all"));
    const [excludeLatestMonth, setExcludeLatestMonth] = useState(() => readStoredBool("spiir_excludeMonth", true));
    const [excludeLatestYear, setExcludeLatestYear] = useState(() => readStoredBool("spiir_excludeYear", false));
    const [heatmap, setHeatmap] = useState(() => readStoredBool("spiir_heatmap", false));
    const [totalSort, setTotalSort] = useState(() => readStoredBool("spiir_totalSort", false));
    const [showPrevTotals, setShowPrevTotals] = useState(() => readStoredBool("spiir_prevAvgDelta", false));
    const [monthlyChart, setMonthlyChart] = useState<ChartOptions>({
        show: readStoredBool("chart.monthly.show", true),
        cumulative: readStoredBool("chart.monthly.cum", false),
        stacked: readStoredBool("chart.monthly.stack", false),
        bars: readStoredBool("chart.monthly.bars", false),
        level: readStoredString("chart.monthly.level", "top") as ChartLevel
    });
    const [yearlyChart, setYearlyChart] = useState<ChartOptions>({
        show: readStoredBool("chart.yearly.show", true),
        cumulative: readStoredBool("chart.yearly.cum", false),
        stacked: readStoredBool("chart.yearly.stack", false),
        bars: readStoredBool("chart.yearly.bars", false),
        level: readStoredString("chart.yearly.level", "top") as ChartLevel
    });

    useEffect(() => {
        if (!active) {
            setToolbarHost(null);
            return;
        }
        if (typeof document !== "undefined") {
            setToolbarHost(document.getElementById("spiir-header-controls"));
        }
        void loadSpiir();
    }, [active]);

    useEffect(() => { storeString("spiir_monthCount", monthWindow); }, [monthWindow]);
    useEffect(() => { storeString("spiir_yearCount", yearWindow); }, [yearWindow]);
    useEffect(() => { storeBool("spiir_excludeMonth", excludeLatestMonth); }, [excludeLatestMonth]);
    useEffect(() => { storeBool("spiir_excludeYear", excludeLatestYear); }, [excludeLatestYear]);
    useEffect(() => { storeBool("spiir_heatmap", heatmap); }, [heatmap]);
    useEffect(() => { storeBool("spiir_totalSort", totalSort); }, [totalSort]);
    useEffect(() => { storeBool("spiir_prevAvgDelta", showPrevTotals); }, [showPrevTotals]);
    useEffect(() => {
        storeBool("chart.monthly.show", monthlyChart.show);
        storeBool("chart.monthly.cum", monthlyChart.cumulative);
        storeBool("chart.monthly.stack", monthlyChart.stacked);
        storeBool("chart.monthly.bars", monthlyChart.bars);
        storeString("chart.monthly.level", monthlyChart.level);
    }, [monthlyChart]);
    useEffect(() => {
        storeBool("chart.yearly.show", yearlyChart.show);
        storeBool("chart.yearly.cum", yearlyChart.cumulative);
        storeBool("chart.yearly.stack", yearlyChart.stacked);
        storeBool("chart.yearly.bars", yearlyChart.bars);
        storeString("chart.yearly.level", yearlyChart.level);
    }, [yearlyChart]);

    useEffect(() => {
        if (!nordeaDrilldownModal && !sunburstState) {
            return;
        }

        const handleKeyDown = (event: KeyboardEvent): void => {
            if (event.key !== "Escape") {
                return;
            }
            event.preventDefault();
            if (nordeaDrilldownModal) {
                setNordeaDrilldownModal(null);
                return;
            }
            closeSunburst();
        };

        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [nordeaDrilldownModal, sunburstState]);

    function scheduleBackgroundSpiirRefresh(attempt = 1): void {
        const refreshId = backgroundRefreshIdRef.current + 1;
        backgroundRefreshIdRef.current = refreshId;
        window.setTimeout(() => {
            if (backgroundRefreshIdRef.current !== refreshId) {
                return;
            }
            void getSpiirStatus()
                .then(async (nextStatus) => {
                    if (backgroundRefreshIdRef.current !== refreshId) {
                        return;
                    }
                    setStatus(nextStatus);
                    if (nextStatus.rebuild_required && attempt < 5) {
                        scheduleBackgroundSpiirRefresh(attempt + 1);
                        return;
                    }
                    if (nextStatus.processed_exists) {
                        setOverview(await getSpiirOverview());
                        setTransactions(null);
                    }
                })
                .catch((loadError) => setError(loadError instanceof Error ? loadError.message : "Kunne ikke hente Spiir-data"));
        }, 4000);
    }

    async function loadSpiir(): Promise<void> {
        setError(null);
        try {
            const nextStatus = await getSpiirStatus();
            setStatus(nextStatus);
            if (nextStatus.rebuild_required) {
                void scheduleSpiirRebuildFromLocal(0)
                    .then(() => scheduleBackgroundSpiirRefresh())
                    .catch(() => undefined);
            }
            if (nextStatus.processed_exists) {
                setOverview(await getSpiirOverview());
            } else {
                setOverview(null);
                setTransactions(null);
            }
        } catch (loadError) {
            setError(loadError instanceof Error ? loadError.message : "Kunne ikke hente Spiir-data");
        }
    }

    async function handleRebuildFromLocal(): Promise<void> {
        setBusy(true);
        setError(null);
        try {
            await rebuildSpiirFromLocal();
            setTransactions(null);
            await loadSpiir();
        } catch (updateError) {
            setError(updateError instanceof Error ? updateError.message : "Kunne ikke bygge Spiir fra ledger");
        } finally {
            setBusy(false);
        }
    }

    async function ensureTransactionsLoaded(): Promise<SpiirTransaction[]> {
        if (transactions !== null) {
            return transactions;
        }
        if (!status?.processed_exists) {
            const missingError = new Error("Spiir er ikke bygget endnu. Klik Byg fra ledger først.");
            setError(missingError.message);
            throw missingError;
        }
        setBusy(true);
        setError(null);
        try {
            const loaded = await getSpiirTransactions();
            setTransactions(loaded);
            return loaded;
        } catch (loadError) {
            setError(loadError instanceof Error ? loadError.message : "Kunne ikke hente transaktioner");
            throw loadError;
        } finally {
            setBusy(false);
        }
    }

    async function handleOpenDrilldown(row: SpiirOverviewRow, title: string, periods: string[], kind: PeriodKind): Promise<void> {
        const drilldownFilter = drilldownFilterFromOverviewRow(row, periods, kind);
        setNordeaDrilldownModal({
            ...drilldownFilter,
            title,
        });
    }

    async function handleOpenSunburst(title: string, periods: string[], mode: SunburstMode, rows: SpiirOverviewRow[]): Promise<void> {
        setSunburstState({ title, periods, mode, rows });
    }

    function closeSunburst(): void {
        setSunburstState(null);
    }

    function openNordeaDrilldownFromTransactions(title: string, items: SpiirTransaction[]): void {
        const categoryFilter = categoryOptionFromTransactions(items);
        setNordeaDrilldownModal({
            title,
            periodFilter: periodFilterFromTransactions(items),
            visibilityFilter: categoryFilter ? "category" : "all",
            categoryFilter,
            searchText: items.length === 1 ? String(items[0].description ?? "") : "",
        });
    }

    const monthly = overview?.monthly;
    const yearly = overview?.yearly;
    const monthlyVisiblePeriods = useMemo(() => visibleMonthPeriods(monthly?.periods ?? [], monthWindow, excludeLatestMonth), [excludeLatestMonth, monthWindow, monthly?.periods]);
    const yearlyVisiblePeriods = useMemo(() => visibleYearPeriods(yearly?.periods ?? [], yearWindow, excludeLatestYear), [excludeLatestYear, yearWindow, yearly?.periods]);
    const monthlyPrevPeriods = useMemo(() => previousWindow(monthly?.periods ?? [], monthlyVisiblePeriods), [monthly?.periods, monthlyVisiblePeriods]);
    const yearlyPrevPeriods = useMemo(() => previousWindow(yearly?.periods ?? [], yearlyVisiblePeriods), [yearly?.periods, yearlyVisiblePeriods]);
    const monthlyChartFigure = useMemo(
        () => monthly && monthlyVisiblePeriods.length > 0 ? buildPeriodChartFigure(monthly, monthlyVisiblePeriods, "month", monthlyChart) : null,
        [monthly, monthlyChart, monthlyVisiblePeriods]
    );
    const yearlyChartFigure = useMemo(
        () => yearly && yearlyVisiblePeriods.length > 0 ? buildPeriodChartFigure(yearly, yearlyVisiblePeriods, "year", yearlyChart) : null,
        [yearly, yearlyChart, yearlyVisiblePeriods]
    );
    const monthYearOptions = useMemo(() => {
        const years = [...new Set((monthly?.periods ?? []).map((period) => period.slice(0, 4)))].sort();
        return [...MONTH_WINDOW_OPTIONS, ...years.map((year) => ({ value: `y:${year}`, label: year }))];
    }, [monthly?.periods]);
    const currentChart = tab === "monthly" ? monthlyChart : yearlyChart;
    const setCurrentChart = tab === "monthly" ? setMonthlyChart : setYearlyChart;
    const currentChartFigure = tab === "monthly" ? monthlyChartFigure : yearlyChartFigure;
    const currentWindow = tab === "monthly" ? monthWindow : yearWindow;
    const setCurrentWindow = tab === "monthly" ? setMonthWindow : setYearWindow;
    const currentWindowOptions = tab === "monthly" ? monthYearOptions : YEAR_WINDOW_OPTIONS;
    const currentExcludeLatest = tab === "monthly" ? excludeLatestMonth : excludeLatestYear;
    const setCurrentExcludeLatest = tab === "monthly" ? setExcludeLatestMonth : setExcludeLatestYear;
    const toolbar = active && toolbarHost ? createPortal(
        <div className="spiir-header-tools">
            <div className="scope-switcher" aria-label="Vælg Spiir-visning">
                <button type="button" className={tab === "monthly" ? "nav-pill active" : "nav-pill"} onClick={() => setTab("monthly")}>
                    Måned
                </button>
                <button type="button" className={tab === "yearly" ? "nav-pill active" : "nav-pill"} onClick={() => setTab("yearly")}>
                    År
                </button>
            </div>
            <label className="spiir-header-control spiir-window-control">
                <select className="spiir-window-select" value={currentWindow} onChange={(event) => setCurrentWindow(event.target.value)}>
                    {currentWindowOptions.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                </select>
            </label>
            <div className="scope-switcher spiir-toggle-group" aria-label="Spiir toggles">
                <TogglePill label="Skip sidste" active={currentExcludeLatest} onClick={() => setCurrentExcludeLatest(!currentExcludeLatest)} />
                <TogglePill label="Heatmap" active={heatmap} onClick={() => setHeatmap(!heatmap)} />
                <TogglePill label="Flat" active={totalSort} onClick={() => setTotalSort(!totalSort)} />
                <TogglePill label="Prev" active={showPrevTotals} onClick={() => setShowPrevTotals(!showPrevTotals)} />
                <TogglePill label="Chart" active={currentChart.show} onClick={() => setCurrentChart((current) => ({ ...current, show: !current.show }))} />
            </div>
        </div>,
        toolbarHost
    ) : null;

    return (
        <section className="spiir-shell">
            {toolbar}
            {error ? <p className="error-banner">{error}</p> : null}
            {status?.rebuild_required ? (
                <div className="info-banner banner-with-action">
                    <span>
                        Spiir-overblikket er forældet. Byg fra ledger for at opdatere det.
                    </span>
                    <button type="button" className="secondary-button" onClick={() => void handleRebuildFromLocal()} disabled={busy}>
                        {busy ? "Bygger..." : "Byg fra ledger"}
                    </button>
                </div>
            ) : null}
            {!status?.processed_exists ? (
                <div className="info-banner banner-with-action">
                    <span>Der er ingen bygget Spiir-oversigt endnu. Byg fra ledger for at åbne oversigten.</span>
                    <button type="button" className="secondary-button" onClick={() => void handleRebuildFromLocal()} disabled={busy}>
                        {busy ? "Bygger..." : "Byg fra ledger"}
                    </button>
                </div>
            ) : null}

            {currentChart.show && currentChartFigure ? (
                <section className="panel spiir-panel spiir-plot-panel">
                    <div className="spiir-plot-surface">
                        <div className="panel-header compact-header spiir-plot-header">
                            <div>
                                <h2>{tab === "monthly" ? "Månedschart" : "Årchart"}</h2>
                                <span>Samme top-chart controls som den gamle Spiir-visning</span>
                            </div>
                            <div className="spiir-control-bar spiir-control-bar-chart">
                                <TogglePill label="Cumulative" active={currentChart.cumulative} onClick={() => setCurrentChart((current) => ({ ...current, cumulative: !current.cumulative }))} />
                                <TogglePill label="Stack" active={currentChart.stacked} onClick={() => setCurrentChart((current) => ({ ...current, stacked: !current.stacked }))} />
                                <TogglePill label="Bars" active={currentChart.bars} onClick={() => setCurrentChart((current) => ({ ...current, bars: !current.bars }))} />
                                <label className="spiir-sort-select-wrap spiir-inline-control">
                                    <span>Level</span>
                                    <select
                                        value={currentChart.level}
                                        onChange={(event) => setCurrentChart((current) => ({ ...current, level: event.target.value as ChartLevel }))}
                                    >
                                        <option value="top">Top</option>
                                        <option value="main">Main</option>
                                        <option value="sub">Sub</option>
                                    </select>
                                </label>
                            </div>
                        </div>
                        <Plot
                            data={currentChartFigure.data as never[]}
                            layout={currentChartFigure.layout as never}
                            config={{ displayModeBar: false, responsive: true }}
                            useResizeHandler
                            className="spiir-plot"
                        />
                    </div>
                </section>
            ) : null}

            {tab === "monthly" && monthly ? (
                <OverviewSection
                    title="Månedsoversigt"
                    section={monthly}
                    periodKind="month"
                    visiblePeriods={monthlyVisiblePeriods}
                    prevPeriods={monthlyPrevPeriods}
                    expandedRows={expandedMonthlyRows}
                    totalSort={totalSort}
                    heatmap={heatmap}
                    showPrevTotals={showPrevTotals}
                    onExpandAll={() => setExpandedMonthlyRows(new Set(monthly.rows.map((row) => row.key)))}
                    onCollapseAll={() => setExpandedMonthlyRows(new Set())}
                    onOpenDrilldown={(row, title, periods, kind) => void handleOpenDrilldown(row, title, periods, kind)}
                    onOpenSunburst={(title, periods, mode, rows) => void handleOpenSunburst(title, periods, mode, rows)}
                    onToggle={(key) => setExpandedMonthlyRows((current) => {
                        const next = new Set(current);
                        if (next.has(key)) {
                            next.delete(key);
                        } else {
                            next.add(key);
                        }
                        return next;
                    })}
                />
            ) : null}

            {tab === "yearly" && yearly ? (
                <OverviewSection
                    title="Årsoversigt"
                    section={yearly}
                    periodKind="year"
                    visiblePeriods={yearlyVisiblePeriods}
                    prevPeriods={yearlyPrevPeriods}
                    expandedRows={expandedYearlyRows}
                    totalSort={totalSort}
                    heatmap={heatmap}
                    showPrevTotals={showPrevTotals}
                    onExpandAll={() => setExpandedYearlyRows(new Set(yearly.rows.map((row) => row.key)))}
                    onCollapseAll={() => setExpandedYearlyRows(new Set())}
                    onOpenDrilldown={(row, title, periods, kind) => void handleOpenDrilldown(row, title, periods, kind)}
                    onOpenSunburst={(title, periods, mode, rows) => void handleOpenSunburst(title, periods, mode, rows)}
                    onToggle={(key) => setExpandedYearlyRows((current) => {
                        const next = new Set(current);
                        if (next.has(key)) {
                            next.delete(key);
                        } else {
                            next.add(key);
                        }
                        return next;
                    })}
                />
            ) : null}

            {sunburstState ? (
                <SpiirSunburstModal
                    state={sunburstState}
                    transactions={transactions}
                    closeOnEscape={!nordeaDrilldownModal}
                    ensureTransactionsLoaded={ensureTransactionsLoaded}
                    onClose={closeSunburst}
                    onOpenTransactions={openNordeaDrilldownFromTransactions}
                />
            ) : null}
            {nordeaDrilldownModal ? (
                <div className="modal-backdrop" onClick={() => setNordeaDrilldownModal(null)}>
                    <section className="nordea-drilldown-modal" onClick={(event) => event.stopPropagation()}>
                        <NordeaDashboard
                            key={`${nordeaDrilldownModal.title}|${nordeaDrilldownModal.periodFilter ?? "all"}|${nordeaDrilldownModal.categoryFilter?.categoryId ?? ""}|${nordeaDrilldownModal.searchText ?? ""}`}
                            active
                            source="local-ledger"
                            embedded
                            initialFilter={nordeaDrilldownModal}
                            onClose={() => setNordeaDrilldownModal(null)}
                        />
                    </section>
                </div>
            ) : null}
        </section>
    );
}