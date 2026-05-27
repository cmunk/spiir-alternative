import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import Plot from "react-plotly.js";

import {
    getKvitteringerItem,
    getKvitteringerItemHistory,
    getKvitteringerItemPriceHistory,
    getKvitteringerItems,
    getKvitteringerMerchants,
    getKvitteringerOverview,
    getKvitteringerOverviewSunburst,
    getKvitteringerReceipt,
    getKvitteringerReceipts,
    getKvitteringerStatus,
    importKvitteringerDefault,
    rebuildKvitteringer,
    saveKvitteringerItemCategoryOverride,
    uploadKvitteringerStoreboxJson
} from "./api";
import type {
    KvitteringerCategoryOption,
    KvitteringerImportResponse,
    KvitteringerItemAlias,
    KvitteringerItemClusterDetail,
    KvitteringerItemClusterSummary,
    KvitteringerMerchantSummary,
    KvitteringerOccurrence,
    KvitteringerOverviewResponse,
    KvitteringerOverviewSunburstNode,
    KvitteringerOverviewSunburstResponse,
    KvitteringerReceiptDetail,
    KvitteringerReceiptSummary,
    KvitteringerStatusResponse
} from "./types";

type KvitteringerTab = "oversigt" | "varer" | "butikker" | "kvitteringer";

type DetailContext = "oversigt" | "varer" | "kvitteringer";

type KvitteringerOverviewMode = "grouped" | "flat";

type KvitteringerFilters = {
    dateFrom?: string;
    dateTo?: string;
    merchantKeys?: string[];
};

type MerchantRollup = {
    merchantKey: string;
    merchantName: string;
    purchaseCount: number;
    spendMinor: number;
    minUnitPriceMinor: number | null;
    maxUnitPriceMinor: number | null;
};

type PricePoint = {
    occurrenceId: string;
    purchaseDate: string;
    merchantName: string;
    unitPriceMinor: number;
};

type KvitteringerMerchantDetailState = {
    merchant: KvitteringerMerchantSummary;
    receipts: KvitteringerReceiptSummary[];
    items: KvitteringerItemClusterSummary[];
};

type KvitteringerOverviewRow = {
    key: string;
    label: string;
    level: number;
    parent?: string | null;
    kind: "total" | "merchant" | "items" | "category" | "item";
    values: Record<string, number>;
    merchantKey?: string;
    clusterId?: string;
    categoryKey?: string;
};

type KvitteringerOverviewSunburstState = {
    title: string;
    periods: string[];
    response: KvitteringerOverviewSunburstResponse | null;
};

type KvitteringerOverviewSunburstView = "merchants" | "categories" | "items";

type KvitteringerSunburstFigure = {
    data: object[];
    layout: object;
    itemClusterIds: Record<string, string>;
};

type PlotlyGraphDiv = HTMLElement & {
    on: (eventName: string, handler: (event: any) => void) => void;
    removeListener: (eventName: string, handler: (event: any) => void) => void;
};

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

const ITEMS_ROOT_KEY = "items-root";

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

function compareLocale(left: string | null | undefined, right: string | null | undefined): number {
    return String(left ?? "").localeCompare(String(right ?? ""), "da");
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

function rowTotalForPeriods(values: Record<string, number>, periods: string[]): number {
    return periods.reduce((sum, period) => sum + Number(values[period] ?? 0), 0);
}

function rowAvgForPeriods(values: Record<string, number>, periods: string[]): number {
    if (periods.length === 0) {
        return 0;
    }
    return Math.round(rowTotalForPeriods(values, periods) / periods.length);
}

function mergeRowValues(target: Record<string, number>, values: Record<string, number>): Record<string, number> {
    Object.entries(values).forEach(([period, value]) => {
        target[period] = Number(target[period] ?? 0) + Number(value ?? 0);
    });
    return target;
}

function hasOverviewChildren(rows: KvitteringerOverviewRow[], key: string): boolean {
    return rows.some((row) => row.parent === key);
}

function buildVisibleOverviewRows(rows: KvitteringerOverviewRow[], expandedKeys: Set<string>): KvitteringerOverviewRow[] {
    const byKey = new Map(rows.map((row) => [row.key, row]));
    return rows.filter((row) => {
        let parentKey = row.parent ?? null;
        while (parentKey) {
            if (!expandedKeys.has(parentKey)) {
                return false;
            }
            parentKey = byKey.get(parentKey)?.parent ?? null;
        }
        return true;
    });
}

function buildOverviewRows(
    overview: KvitteringerOverviewResponse,
    visiblePeriods: string[],
    mode: KvitteringerOverviewMode,
    itemLimitSelection: string
): KvitteringerOverviewRow[] {
    const merchantRows: KvitteringerOverviewRow[] = overview.merchants
        .map((merchant) => ({
            key: `merchant:${merchant.merchant_key}`,
            label: merchant.display_name,
            level: 0,
            parent: null,
            kind: "merchant" as const,
            values: merchant.values,
            merchantKey: merchant.merchant_key,
        }))
        .filter((row) => rowTotalForPeriods(row.values, visiblePeriods) !== 0)
        .sort((left, right) => rowTotalForPeriods(right.values, visiblePeriods) - rowTotalForPeriods(left.values, visiblePeriods) || compareLocale(left.label, right.label));

    const rankedItems = overview.items
        .map((item) => ({
            ...item,
            visibleTotal: rowTotalForPeriods(item.values, visiblePeriods),
        }))
        .filter((item) => item.visibleTotal !== 0)
        .sort((left, right) => right.visibleTotal - left.visibleTotal || compareLocale(left.preferred_display_name, right.preferred_display_name));

    const itemLimit = itemLimitSelection === "all"
        ? Number.POSITIVE_INFINITY
        : Number.parseInt(itemLimitSelection, 10) || 50;
    const limitedItems = Number.isFinite(itemLimit) ? rankedItems.slice(0, itemLimit) : rankedItems;

    const rows: KvitteringerOverviewRow[] = [
        {
            key: "total",
            label: "Total",
            level: 0,
            parent: null,
            kind: "total",
            values: overview.totals.values,
        },
        ...merchantRows,
    ];

    if (limitedItems.length === 0) {
        return rows;
    }

    const itemsRootValues = limitedItems.reduce<Record<string, number>>(
        (current, item) => mergeRowValues(current, item.values),
        {}
    );
    rows.push({
        key: ITEMS_ROOT_KEY,
        label: mode === "flat"
            ? (itemLimitSelection === "all" ? "Varer" : `Varer · top ${limitedItems.length}`)
            : (itemLimitSelection === "all" ? "Varetyper" : `Varetyper · top ${limitedItems.length}`),
        level: 0,
        parent: null,
        kind: "items",
        values: itemsRootValues,
    });

    if (mode === "flat") {
        limitedItems.forEach((item) => {
            rows.push({
                key: `item:${item.cluster_id}`,
                label: item.preferred_display_name,
                level: 1,
                parent: ITEMS_ROOT_KEY,
                kind: "item",
                values: item.values,
                clusterId: item.cluster_id,
                categoryKey: item.category_key,
            });
        });
        return rows;
    }

    const categories = new Map<string, {
        key: string;
        label: string;
        values: Record<string, number>;
        items: typeof limitedItems;
    }>();

    limitedItems.forEach((item) => {
        const current = categories.get(item.category_key) ?? {
            key: item.category_key,
            label: item.category_label,
            values: {},
            items: [],
        };
        current.items.push(item);
        mergeRowValues(current.values, item.values);
        categories.set(item.category_key, current);
    });

    [...categories.values()]
        .sort((left, right) => rowTotalForPeriods(right.values, visiblePeriods) - rowTotalForPeriods(left.values, visiblePeriods) || compareLocale(left.label, right.label))
        .forEach((category) => {
            const categoryKey = `category:${category.key}`;
            rows.push({
                key: categoryKey,
                label: category.label,
                level: 1,
                parent: ITEMS_ROOT_KEY,
                kind: "category",
                values: category.values,
                categoryKey: category.key,
            });
            category.items
                .sort((left, right) => rowTotalForPeriods(right.values, visiblePeriods) - rowTotalForPeriods(left.values, visiblePeriods) || compareLocale(left.preferred_display_name, right.preferred_display_name))
                .forEach((item) => {
                    rows.push({
                        key: `item:${item.cluster_id}`,
                        label: item.preferred_display_name,
                        level: 2,
                        parent: categoryKey,
                        kind: "item",
                        values: item.values,
                        clusterId: item.cluster_id,
                        categoryKey: item.category_key,
                    });
                });
        });

    return rows;
}

function OverviewTogglePill({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
    return (
        <button
            type="button"
            className={active ? "spiir-pill-toggle active" : "spiir-pill-toggle"}
            aria-pressed={active}
            onClick={onClick}
        >
            {label}
        </button>
    );
}

function formatMinor(value: number | null | undefined): string {
    if (value === null || value === undefined || Number.isNaN(value)) {
        return "-";
    }
    return new Intl.NumberFormat("da-DK", {
        style: "currency",
        currency: "DKK",
        maximumFractionDigits: 2,
        minimumFractionDigits: 2
    }).format(value / 100);
}

function formatCompactMinor(value: number): string {
    return `${new Intl.NumberFormat("da-DK", {
        notation: "compact",
        maximumFractionDigits: 1,
        minimumFractionDigits: 0,
    }).format(value / 100)} kr.`;
}

function formatDate(value: string | null | undefined): string {
    if (!value) {
        return "-";
    }
    const [year, month, day] = value.slice(0, 10).split("-");
    return `${day}/${month}/${year}`;
}

function formatDateTime(value: string | null | undefined): string {
    if (!value) {
        return "-";
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return value;
    }
    return new Intl.DateTimeFormat("da-DK", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit"
    }).format(date);
}

function toInputDate(value: Date): string {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

function getDefaultDateRange(): { dateFrom: string; dateTo: string } {
    const dateTo = new Date();
    const dateFrom = new Date(dateTo);
    dateFrom.setFullYear(dateFrom.getFullYear() - 1);
    return {
        dateFrom: toInputDate(dateFrom),
        dateTo: toInputDate(dateTo)
    };
}

function formatQuantity(value: number | null | undefined): string {
    if (value === null || value === undefined || Number.isNaN(value)) {
        return "-";
    }
    if (Math.abs(value - Math.round(value)) < 0.0001) {
        return String(Math.round(value));
    }
    return new Intl.NumberFormat("da-DK", {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2
    }).format(value);
}

function formatUnitSummary(occurrence: KvitteringerOccurrence): string {
    if (occurrence.unit_price_minor === null || occurrence.unit_price_minor === undefined) {
        return formatQuantity(occurrence.quantity);
    }
    return `${formatQuantity(occurrence.quantity)} x ${formatMinor(occurrence.unit_price_minor)}`;
}

function formatCategorySource(source: string, isOverride: boolean): string {
    if (isOverride || source === "manual") {
        return "Manuel override";
    }
    if (source === "taxonomy_name") {
        return "Auto via varenavn";
    }
    if (source === "taxonomy_code") {
        return "Auto via Storebox-type";
    }
    return "Auto fallback";
}

function currentFilters(
    dateFrom: string,
    dateTo: string,
    merchantKeys: string[],
    includeDateRange: boolean = true
): KvitteringerFilters {
    return {
        dateFrom: includeDateRange ? dateFrom || undefined : undefined,
        dateTo: includeDateRange ? dateTo || undefined : undefined,
        merchantKeys: merchantKeys.length > 0 ? merchantKeys : undefined
    };
}

function filtersForTab(
    tab: KvitteringerTab,
    dateFrom: string,
    dateTo: string,
    merchantKeys: string[]
): KvitteringerFilters {
    return currentFilters(dateFrom, dateTo, merchantKeys, tab !== "oversigt");
}

function filtersForContext(
    context: DetailContext,
    dateFrom: string,
    dateTo: string,
    merchantKeys: string[]
): KvitteringerFilters {
    return currentFilters(dateFrom, dateTo, merchantKeys, context !== "oversigt");
}

function buildMerchantBreakdown(history: KvitteringerOccurrence[]): MerchantRollup[] {
    const byMerchant = new Map<string, MerchantRollup>();
    for (const occurrence of history) {
        const existing = byMerchant.get(occurrence.merchant_key);
        const unitPrice = occurrence.unit_price_minor ?? null;
        if (!existing) {
            byMerchant.set(occurrence.merchant_key, {
                merchantKey: occurrence.merchant_key,
                merchantName: occurrence.merchant_name ?? occurrence.merchant_key,
                purchaseCount: 1,
                spendMinor: occurrence.net_total_minor,
                minUnitPriceMinor: unitPrice,
                maxUnitPriceMinor: unitPrice
            });
            continue;
        }
        existing.purchaseCount += 1;
        existing.spendMinor += occurrence.net_total_minor;
        if (unitPrice !== null) {
            existing.minUnitPriceMinor = existing.minUnitPriceMinor === null ? unitPrice : Math.min(existing.minUnitPriceMinor, unitPrice);
            existing.maxUnitPriceMinor = existing.maxUnitPriceMinor === null ? unitPrice : Math.max(existing.maxUnitPriceMinor, unitPrice);
        }
    }
    return [...byMerchant.values()].sort((left, right) => right.spendMinor - left.spendMinor || left.merchantName.localeCompare(right.merchantName));
}

function filterReceipts(receipts: KvitteringerReceiptSummary[], query: string): KvitteringerReceiptSummary[] {
    const normalizedQuery = query.trim().toUpperCase();
    if (!normalizedQuery) {
        return receipts;
    }
    return receipts.filter((receipt) => (
        receipt.receipt_id.toUpperCase().includes(normalizedQuery)
        || receipt.merchant_name.toUpperCase().includes(normalizedQuery)
        || receipt.merchant_key.toUpperCase().includes(normalizedQuery)
    ));
}

function buildPricePoints(history: KvitteringerOccurrence[]): PricePoint[] {
    return history
        .filter((occurrence) => typeof occurrence.unit_price_minor === "number" && !!occurrence.purchase_date)
        .map((occurrence) => ({
            occurrenceId: occurrence.occurrence_id,
            purchaseDate: occurrence.purchase_date,
            merchantName: occurrence.merchant_name ?? occurrence.merchant_key,
            unitPriceMinor: occurrence.unit_price_minor as number
        }))
        .sort((left, right) => left.purchaseDate.localeCompare(right.purchaseDate));
}

function hash32(value: string): number {
    let hash = 0;
    for (let index = 0; index < value.length; index += 1) {
        hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
    }
    return Math.abs(hash);
}

function kvitteringerSunburstColor(node: KvitteringerOverviewSunburstNode): string {
    if (node.kind === "root") {
        return "rgba(132, 125, 110, 0.28)";
    }
    const hue = hash32(`${node.kind}:${node.label}:${node.merchant_key ?? ""}`) % 360;
    if (node.kind === "merchant") {
        return `hsla(${hue}, 52%, 66%, 0.74)`;
    }
    if (node.kind === "category") {
        return `hsla(${hue}, 60%, 74%, 0.68)`;
    }
    return `hsla(${hue}, 72%, 82%, 0.62)`;
}

function buildKvitteringerSunburstFigure(
    title: string,
    payload: KvitteringerOverviewSunburstResponse,
    view: KvitteringerOverviewSunburstView
): KvitteringerSunburstFigure | null {
    if (payload.nodes.length === 0) {
        return null;
    }

    const visibleNodes = view === "merchants" ? payload.nodes : (() => {
        const rootLabel = payload.nodes.find((node) => node.kind === "root")?.label ?? "Varenetto";
        const categoryNodes = new Map<string, KvitteringerOverviewSunburstNode>();
        const itemNodes = new Map<string, KvitteringerOverviewSunburstNode>();

        payload.nodes.forEach((node) => {
            if (node.kind === "category" && view === "categories") {
                const categoryKey = String(node.category_key ?? node.label);
                const categoryId = `category:${categoryKey}`;
                const existing = categoryNodes.get(categoryId);
                if (existing) {
                    existing.value_minor += node.value_minor;
                    return;
                }
                categoryNodes.set(categoryId, {
                    ...node,
                    id: categoryId,
                    parent_id: "root",
                    merchant_key: null,
                });
                return;
            }

            if (node.kind !== "item") {
                return;
            }

            const categoryKey = String(node.category_key ?? "uncategorized");
            const clusterKey = String(node.cluster_id ?? node.id);

            if (view === "categories") {
                const categoryId = `category:${categoryKey}`;
                if (!categoryNodes.has(categoryId)) {
                    categoryNodes.set(categoryId, {
                        id: categoryId,
                        parent_id: "root",
                        kind: "category",
                        label: String(node.category_key ?? node.label),
                        value_minor: 0,
                        merchant_key: null,
                        category_key: categoryKey,
                    });
                }
                const itemId = `item:${categoryKey}:${clusterKey}`;
                const existing = itemNodes.get(itemId);
                if (existing) {
                    existing.value_minor += node.value_minor;
                    return;
                }
                itemNodes.set(itemId, {
                    ...node,
                    id: itemId,
                    parent_id: categoryId,
                    merchant_key: null,
                    category_key: categoryKey,
                });
                return;
            }

            const itemId = `item:${clusterKey}`;
            const existing = itemNodes.get(itemId);
            if (existing) {
                existing.value_minor += node.value_minor;
                return;
            }
            itemNodes.set(itemId, {
                ...node,
                id: itemId,
                parent_id: "root",
                merchant_key: null,
                category_key: null,
            });
        });

        return [
            {
                id: "root",
                parent_id: "",
                kind: "root" as const,
                label: rootLabel,
                value_minor: payload.positive_net_spend_minor,
            },
            ...(view === "categories"
                ? [...categoryNodes.values()].sort((left, right) => right.value_minor - left.value_minor || compareLocale(left.label, right.label))
                : []),
            ...[...itemNodes.values()].sort((left, right) => right.value_minor - left.value_minor || compareLocale(left.label, right.label)),
        ];
    })();

    const ids: string[] = [];
    const labels: string[] = [];
    const parents: string[] = [];
    const values: number[] = [];
    const colors: string[] = [];
    const text: string[] = [];
    const itemClusterIds: Record<string, string> = {};

    visibleNodes.forEach((node) => {
        ids.push(node.id);
        labels.push(node.label);
        parents.push(node.parent_id);
        values.push(node.value_minor / 100);
        colors.push(kvitteringerSunburstColor(node));
        text.push(`${node.label}<br>${formatCompactMinor(node.value_minor)}`);
        if (node.kind === "item" && node.cluster_id) {
            itemClusterIds[node.id] = node.cluster_id;
        }
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
                    line: { color: "rgba(110, 92, 60, 0.18)", width: 1 },
                },
                hovertemplate: "%{label}<br>%{value:.2f} kr.<br>%{percentParent:.1%}<extra></extra>",
                insidetextorientation: "radial",
            },
        ],
        layout: {
            margin: { l: 10, r: 10, t: 8, b: 10 },
            paper_bgcolor: "rgba(0,0,0,0)",
            plot_bgcolor: "rgba(0,0,0,0)",
        },
        itemClusterIds,
    };
}

export default function KvitteringerDashboard({ active }: { active: boolean }) {
    const initialDateRange = getDefaultDateRange();
    const itemSidePanelRef = useRef<HTMLElement | null>(null);
    const merchantSelectRef = useRef<HTMLDetailsElement | null>(null);
    const uploadInputRef = useRef<HTMLInputElement | null>(null);
    const [showReceiptSidePanel, setShowReceiptSidePanel] = useState(false);
    const [status, setStatus] = useState<KvitteringerStatusResponse | null>(null);
    const [overview, setOverview] = useState<KvitteringerOverviewResponse | null>(null);
    const [receipts, setReceipts] = useState<KvitteringerReceiptSummary[]>([]);
    const [merchants, setMerchants] = useState<KvitteringerMerchantSummary[]>([]);
    const [merchantOptions, setMerchantOptions] = useState<KvitteringerMerchantSummary[]>([]);
    const [items, setItems] = useState<KvitteringerItemClusterSummary[]>([]);
    const [selectedReceipt, setSelectedReceipt] = useState<KvitteringerReceiptDetail | null>(null);
    const [selectedReceiptContext, setSelectedReceiptContext] = useState<DetailContext | null>(null);
    const [selectedItem, setSelectedItem] = useState<KvitteringerItemClusterDetail | null>(null);
    const [selectedItemContext, setSelectedItemContext] = useState<DetailContext | null>(null);
    const [selectedMerchantDetail, setSelectedMerchantDetail] = useState<KvitteringerMerchantDetailState | null>(null);
    const [selectedMerchantContext, setSelectedMerchantContext] = useState<DetailContext | null>(null);
    const [selectedItemHistory, setSelectedItemHistory] = useState<KvitteringerOccurrence[]>([]);
    const [selectedItemPriceHistory, setSelectedItemPriceHistory] = useState<KvitteringerOccurrence[]>([]);
    const [selectedTab, setSelectedTab] = useState<KvitteringerTab>("kvitteringer");
    const [granularity, setGranularity] = useState<"month" | "year">("month");
    const [overviewMonthWindow, setOverviewMonthWindow] = useState(() => readStoredString("kvitteringer_overview_monthCount", "12"));
    const [overviewYearWindow, setOverviewYearWindow] = useState(() => readStoredString("kvitteringer_overview_yearCount", "all"));
    const [excludeLatestMonth, setExcludeLatestMonth] = useState(() => readStoredBool("kvitteringer_overview_excludeMonth", true));
    const [excludeLatestYear, setExcludeLatestYear] = useState(() => readStoredBool("kvitteringer_overview_excludeYear", false));
    const [overviewMode, setOverviewMode] = useState<KvitteringerOverviewMode>(() => readStoredString("kvitteringer_overview_mode", "grouped") === "flat" ? "flat" : "grouped");
    const [overviewItemLimit, setOverviewItemLimit] = useState(() => readStoredString("kvitteringer_overview_itemLimit", "50") === "all" ? "all" : "50");
    const [expandedOverviewRows, setExpandedOverviewRows] = useState<Set<string>>(new Set([ITEMS_ROOT_KEY]));
    const [itemSearchInput, setItemSearchInput] = useState("");
    const [itemSearch, setItemSearch] = useState("");
    const [receiptSearch, setReceiptSearch] = useState("");
    const [dateFrom, setDateFrom] = useState(initialDateRange.dateFrom);
    const [dateTo, setDateTo] = useState(initialDateRange.dateTo);
    const [selectedMerchantKeys, setSelectedMerchantKeys] = useState<string[]>([]);
    const [busy, setBusy] = useState(false);
    const [receiptLoading, setReceiptLoading] = useState(false);
    const [itemLoading, setItemLoading] = useState(false);
    const [itemCategoryDraft, setItemCategoryDraft] = useState("");
    const [itemCategorySaving, setItemCategorySaving] = useState(false);
    const [merchantLoading, setMerchantLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [lastAction, setLastAction] = useState<KvitteringerImportResponse | null>(null);
    const [overviewSunburstState, setOverviewSunburstState] = useState<KvitteringerOverviewSunburstState | null>(null);
    const [overviewSunburstGraphDiv, setOverviewSunburstGraphDiv] = useState<PlotlyGraphDiv | null>(null);
    const [overviewSunburstView, setOverviewSunburstView] = useState<KvitteringerOverviewSunburstView>("merchants");

    const visibleReceipts = filterReceipts(receipts, receiptSearch);
    const selectedItemMerchantBreakdown = buildMerchantBreakdown(selectedItemHistory);
    const selectedReceiptDiscountTotalMinor = selectedReceipt
        ? selectedReceipt.receipt.attributed_discount_total_minor + selectedReceipt.receipt.unassigned_discount_total_minor
        : 0;
    const selectedItemPricePoints = buildPricePoints(selectedItemPriceHistory);
    const priceChartValues = selectedItemPricePoints.map((point) => point.unitPriceMinor);
    const priceChartMin = priceChartValues.length > 0 ? Math.min(...priceChartValues) : null;
    const priceChartMax = priceChartValues.length > 0 ? Math.max(...priceChartValues) : null;
    const latestPricePoint = selectedItemPricePoints.length > 0 ? selectedItemPricePoints[selectedItemPricePoints.length - 1] : null;
    const priceChartTrace = [{
        type: "scatter",
        mode: "lines+markers",
        x: selectedItemPricePoints.map((point) => point.purchaseDate),
        y: selectedItemPricePoints.map((point) => point.unitPriceMinor / 100),
        text: selectedItemPricePoints.map((point) => `${formatDate(point.purchaseDate)} · ${point.merchantName}`),
        hovertemplate: "%{text}<br>Pris %{y:.2f} kr.<extra></extra>",
        line: {
            color: "rgba(43, 112, 95, 0.82)",
            width: 2
        },
        marker: {
            color: "rgba(43, 112, 95, 0.92)",
            size: 6
        },
        fill: "tozeroy",
        fillcolor: "rgba(43, 112, 95, 0.08)"
    }];
    const priceChartLayout = {
        autosize: true,
        height: 176,
        margin: { l: 34, r: 16, t: 8, b: 28 },
        paper_bgcolor: "rgba(0,0,0,0)",
        plot_bgcolor: "rgba(0,0,0,0)",
        showlegend: false,
        xaxis: {
            type: "date",
            showgrid: false,
            zeroline: false,
            tickfont: { size: 11, color: "rgba(78, 53, 24, 0.62)" }
        },
        yaxis: {
            ticksuffix: " kr.",
            gridcolor: "rgba(78, 53, 24, 0.08)",
            zeroline: false,
            tickfont: { size: 11, color: "rgba(78, 53, 24, 0.62)" }
        }
    };
    const priceChartConfig = {
        displayModeBar: false,
        responsive: true,
        staticPlot: false
    };
    const overviewMonthOptions = useMemo(() => {
        const years = [...new Set((overview?.periods ?? []).map((period) => period.slice(0, 4)))].sort();
        return [...MONTH_WINDOW_OPTIONS, ...years.map((year) => ({ value: `y:${year}`, label: year }))];
    }, [overview?.periods]);
    const visibleOverviewPeriods = useMemo(
        () => granularity === "month"
            ? visibleMonthPeriods(overview?.periods ?? [], overviewMonthWindow, excludeLatestMonth)
            : visibleYearPeriods(overview?.periods ?? [], overviewYearWindow, excludeLatestYear),
        [excludeLatestMonth, excludeLatestYear, granularity, overview?.periods, overviewMonthWindow, overviewYearWindow]
    );
    const overviewRows = useMemo(
        () => overview ? buildOverviewRows(overview, visibleOverviewPeriods, overviewMode, overviewItemLimit) : [],
        [overview, overviewItemLimit, overviewMode, visibleOverviewPeriods]
    );
    const overviewVisibleRows = useMemo(
        () => buildVisibleOverviewRows(overviewRows, expandedOverviewRows),
        [expandedOverviewRows, overviewRows]
    );
    const overviewExpandableKeys = useMemo(
        () => overviewRows.filter((row) => hasOverviewChildren(overviewRows, row.key)).map((row) => row.key),
        [overviewRows]
    );
    const overviewAllExpanded = overviewExpandableKeys.length > 0 && overviewExpandableKeys.every((key) => expandedOverviewRows.has(key));
    const overviewVisibleReceiptCount = useMemo(
        () => (overview?.period_summaries ?? []).reduce((sum, period) => sum + (visibleOverviewPeriods.includes(period.period) ? period.receipt_count : 0), 0),
        [overview?.period_summaries, visibleOverviewPeriods]
    );
    const overviewVisibleSpendMinor = useMemo(
        () => overview ? rowTotalForPeriods(overview.totals.values, visibleOverviewPeriods) : 0,
        [overview, visibleOverviewPeriods]
    );
    const overviewWindowOptions = granularity === "month" ? overviewMonthOptions : YEAR_WINDOW_OPTIONS;
    const overviewCurrentWindow = granularity === "month" ? overviewMonthWindow : overviewYearWindow;
    const overviewExcludeLatest = granularity === "month" ? excludeLatestMonth : excludeLatestYear;
    const overviewTitle = granularity === "month" ? "Månedsoversigt" : "Årsoversigt";
    const overviewSunburstFigure = useMemo(
        () => overviewSunburstState?.response
            ? buildKvitteringerSunburstFigure(overviewSunburstState.title, overviewSunburstState.response, overviewSunburstView)
            : null,
        [overviewSunburstState, overviewSunburstView]
    );
    const sortedMerchantOptions = useMemo(
        () => [...merchantOptions].sort((left, right) => right.receipt_count - left.receipt_count || compareLocale(left.display_name, right.display_name)),
        [merchantOptions]
    );
    const overviewSunburstSummary = useMemo(() => {
        const payload = overviewSunburstState?.response;
        if (!payload) {
            return null;
        }
        const parts = [`Varenetto ${formatMinor(payload.positive_net_spend_minor)}`];
        if (payload.receipt_total_minor !== payload.positive_net_spend_minor) {
            parts.push(`Kvitteringstotal ${formatMinor(payload.receipt_total_minor)}`);
        }
        if (payload.unassigned_discount_minor > 0) {
            parts.push(`Uafklaret rabat ${formatMinor(payload.unassigned_discount_minor)}`);
        }
        if (payload.excluded_negative_net_spend_minor > 0) {
            parts.push(`Retur/refundering ${formatMinor(payload.excluded_negative_net_spend_minor)}`);
        }
        return parts.join(" · ");
    }, [overviewSunburstState]);
    const merchantSelectionLabel = useMemo(() => {
        if (selectedMerchantKeys.length === 0 || (merchantOptions.length > 0 && selectedMerchantKeys.length === merchantOptions.length)) {
            return "Alle butikker";
        }
        const optionByKey = new Map(sortedMerchantOptions.map((merchant) => [merchant.merchant_key, merchant.display_name]));
        const labels = selectedMerchantKeys.map((merchantKey) => optionByKey.get(merchantKey) ?? merchantKey);
        if (labels.length === 1) {
            return labels[0];
        }
        if (labels.length === 2) {
            return `${labels[0]}, ${labels[1]}`;
        }
        return `${labels.length} butikker`;
    }, [merchantOptions.length, selectedMerchantKeys, sortedMerchantOptions]);

    useEffect(() => {
        const mediaQuery = window.matchMedia("(min-width: 1380px)");
        const update = () => setShowReceiptSidePanel(mediaQuery.matches);
        update();
        mediaQuery.addEventListener("change", update);
        return () => mediaQuery.removeEventListener("change", update);
    }, []);

    useEffect(() => { storeString("kvitteringer_overview_monthCount", overviewMonthWindow); }, [overviewMonthWindow]);
    useEffect(() => { storeString("kvitteringer_overview_yearCount", overviewYearWindow); }, [overviewYearWindow]);
    useEffect(() => { storeBool("kvitteringer_overview_excludeMonth", excludeLatestMonth); }, [excludeLatestMonth]);
    useEffect(() => { storeBool("kvitteringer_overview_excludeYear", excludeLatestYear); }, [excludeLatestYear]);
    useEffect(() => { storeString("kvitteringer_overview_mode", overviewMode); }, [overviewMode]);
    useEffect(() => { storeString("kvitteringer_overview_itemLimit", overviewItemLimit); }, [overviewItemLimit]);
    useEffect(() => {
        setItemCategoryDraft(selectedItem?.cluster.category_key ?? "");
    }, [selectedItem?.cluster.category_key]);

    useEffect(() => {
        if (!showReceiptSidePanel || !selectedItem?.cluster.cluster_id) {
            return;
        }
        itemSidePanelRef.current?.scrollTo({ top: 0, left: 0 });
    }, [selectedItem?.cluster.cluster_id, showReceiptSidePanel]);

    function clearSelectedReceiptDetail(): void {
        setReceiptLoading(false);
        setSelectedReceipt(null);
        setSelectedReceiptContext(null);
    }

    function clearSelectedItemDetail(): void {
        setItemLoading(false);
        setItemCategorySaving(false);
        setItemCategoryDraft("");
        setSelectedItem(null);
        setSelectedItemContext(null);
        setSelectedItemHistory([]);
        setSelectedItemPriceHistory([]);
    }

    function clearSelectedMerchantDetail(): void {
        setMerchantLoading(false);
        setSelectedMerchantDetail(null);
        setSelectedMerchantContext(null);
    }

    function clearOverviewSunburst(): void {
        setOverviewSunburstGraphDiv(null);
        setOverviewSunburstState(null);
        if (selectedItemContext === "oversigt") {
            clearSelectedItemDetail();
        }
    }

    function captureOverviewSunburstGraphDiv(_figure: unknown, graphDiv: unknown): void {
        const nextGraphDiv = graphDiv as PlotlyGraphDiv | null;
        setOverviewSunburstGraphDiv((current) => current === nextGraphDiv ? current : nextGraphDiv);
    }

    useEffect(() => {
        if (selectedReceiptContext && selectedReceiptContext !== selectedTab) {
            clearSelectedReceiptDetail();
        }
        if (selectedItemContext && selectedItemContext !== selectedTab) {
            clearSelectedItemDetail();
        }
        if (selectedMerchantContext && selectedMerchantContext !== selectedTab) {
            clearSelectedMerchantDetail();
        }
    }, [selectedItemContext, selectedMerchantContext, selectedReceiptContext, selectedTab]);

    async function refreshSelectedItem(clusterId: string, filters: KvitteringerFilters): Promise<void> {
        const [detail, history, priceHistory] = await Promise.all([
            getKvitteringerItem(clusterId),
            getKvitteringerItemHistory(clusterId, filters),
            getKvitteringerItemPriceHistory(clusterId, filters)
        ]);
        setSelectedItem(detail);
        setSelectedItemHistory(history);
        setSelectedItemPriceHistory(priceHistory);
    }

    async function refreshSelectedMerchantDetail(
        merchantKeyValue: string,
        filters: KvitteringerFilters,
        merchantList: KvitteringerMerchantSummary[] = merchants
    ): Promise<void> {
        const merchantSummary = merchantList.find((merchant) => merchant.merchant_key === merchantKeyValue);
        if (!merchantSummary) {
            clearSelectedMerchantDetail();
            return;
        }

        const [merchantReceipts, merchantItems] = await Promise.all([
            getKvitteringerReceipts(filters),
            getKvitteringerItems("", filters)
        ]);
        setSelectedMerchantDetail({
            merchant: merchantSummary,
            receipts: merchantReceipts,
            items: merchantItems
        });
    }

    async function loadDashboard(next: {
        itemSearch?: string;
        granularity?: "month" | "year";
        dateFrom?: string;
        dateTo?: string;
        merchantKeys?: string[];
        tab?: KvitteringerTab;
        refreshStaticData?: boolean;
    } = {}): Promise<void> {
        const nextTab = next.tab ?? selectedTab;
        const nextGranularity = next.granularity ?? granularity;
        const nextItemSearch = next.itemSearch ?? itemSearch;
        const nextDateFrom = next.dateFrom ?? dateFrom;
        const nextDateTo = next.dateTo ?? dateTo;
        const nextMerchantKeys = next.merchantKeys ?? selectedMerchantKeys;
        const filters = filtersForTab(nextTab, nextDateFrom, nextDateTo, nextMerchantKeys);
        const refreshStaticData = next.refreshStaticData ?? false;
        const statusRequest: Promise<KvitteringerStatusResponse> = refreshStaticData || !status
            ? getKvitteringerStatus()
            : Promise.resolve(status);
        const merchantOptionsRequest: Promise<KvitteringerMerchantSummary[]> = refreshStaticData || merchantOptions.length === 0
            ? getKvitteringerMerchants()
            : Promise.resolve(merchantOptions);

        const [nextStatus, nextOverview, nextReceipts, nextMerchants, nextMerchantOptions, nextItems] = await Promise.all([
            statusRequest,
            getKvitteringerOverview(nextGranularity, filters),
            getKvitteringerReceipts(filters),
            getKvitteringerMerchants(filters),
            merchantOptionsRequest,
            getKvitteringerItems(nextItemSearch, filters)
        ]);

        setStatus(nextStatus);
        setOverview(nextOverview);
        setReceipts(nextReceipts);
        setMerchants(nextMerchants);
        setMerchantOptions(nextMerchantOptions);
        setItems(nextItems);

        if (selectedItem?.cluster.cluster_id && selectedItemContext === nextTab) {
            await refreshSelectedItem(
                selectedItem.cluster.cluster_id,
                filtersForContext(selectedItemContext, nextDateFrom, nextDateTo, nextMerchantKeys)
            );
        }
        if (selectedMerchantDetail?.merchant.merchant_key && selectedMerchantContext === nextTab) {
            setMerchantLoading(true);
            try {
                await refreshSelectedMerchantDetail(
                    selectedMerchantDetail.merchant.merchant_key,
                    filtersForContext(selectedMerchantContext, nextDateFrom, nextDateTo, [selectedMerchantDetail.merchant.merchant_key]),
                    nextMerchants
                );
            } finally {
                setMerchantLoading(false);
            }
        }
    }

    useEffect(() => {
        if (!active) {
            return;
        }
        void (async () => {
            setBusy(true);
            setError(null);
            try {
                await loadDashboard();
            } catch (loadError) {
                setError(loadError instanceof Error ? loadError.message : "Kunne ikke hente kvitteringer");
            } finally {
                setBusy(false);
            }
        })();
    }, [active]);

    useEffect(() => {
        if (!active || selectedTab !== "kvitteringer" || !showReceiptSidePanel) {
            return;
        }
        if (receipts.length === 0) {
            if (selectedReceipt) {
                clearSelectedReceiptDetail();
            }
            return;
        }

        const selectedReceiptId = selectedReceipt?.receipt.receipt_id;
        if (selectedReceiptContext === "kvitteringer" && selectedReceiptId && receipts.some((receipt) => receipt.receipt_id === selectedReceiptId)) {
            return;
        }

        void handleSelectReceipt(receipts[0].receipt_id, "kvitteringer");
    }, [active, receipts, selectedReceipt, selectedReceiptContext, selectedTab, showReceiptSidePanel]);

    useEffect(() => {
        if (!active || selectedTab !== "varer" || !showReceiptSidePanel) {
            return;
        }
        if (items.length === 0) {
            if (selectedItem) {
                clearSelectedItemDetail();
            }
            return;
        }

        const selectedItemId = selectedItem?.cluster.cluster_id;
        if (selectedItemContext === "varer" && selectedItemId && items.some((item) => item.cluster_id === selectedItemId)) {
            return;
        }

        void handleSelectItem(items[0].cluster_id, "varer");
    }, [active, items, selectedItem, selectedItemContext, selectedTab, showReceiptSidePanel]);

    useEffect(() => {
        if (!active) {
            return;
        }

        const handlePointerDown = (event: PointerEvent): void => {
            const details = merchantSelectRef.current;
            if (!details?.open || details.contains(event.target as Node)) {
                return;
            }
            details.open = false;
            void handleApplyFilters();
        };

        document.addEventListener("pointerdown", handlePointerDown);
        return () => document.removeEventListener("pointerdown", handlePointerDown);
    }, [active, dateFrom, dateTo, itemSearch, selectedMerchantKeys, selectedTab]);

    useEffect(() => {
        if (selectedTab !== "oversigt" && overviewSunburstState) {
            clearOverviewSunburst();
        }
    }, [overviewSunburstState, selectedTab]);

    async function handleImport(action: "import" | "rebuild"): Promise<void> {
        setBusy(true);
        setError(null);
        try {
            const result = action === "import" ? await importKvitteringerDefault() : await rebuildKvitteringer();
            setLastAction(result);
            await loadDashboard({ refreshStaticData: true });
        } catch (actionError) {
            setError(actionError instanceof Error ? actionError.message : "Import fejlede");
        } finally {
            setBusy(false);
        }
    }

    async function handleStoreboxUpload(file: File): Promise<void> {
        setBusy(true);
        setError(null);
        try {
            const result = await uploadKvitteringerStoreboxJson(file);
            setLastAction(result);
            await loadDashboard({ refreshStaticData: true });
        } catch (uploadError) {
            setError(uploadError instanceof Error ? uploadError.message : "Upload fejlede");
        } finally {
            setBusy(false);
        }
    }

    async function handleStoreboxUploadChange(event: ChangeEvent<HTMLInputElement>): Promise<void> {
        const nextFile = event.target.files?.[0];
        event.target.value = "";
        if (!nextFile) {
            return;
        }
        await handleStoreboxUpload(nextFile);
    }

    async function handleApplyFilters(): Promise<void> {
        setBusy(true);
        setError(null);
        try {
            await loadDashboard({
                dateFrom,
                dateTo,
                merchantKeys: selectedMerchantKeys,
                tab: selectedTab,
                itemSearch
            });
        } catch (filterError) {
            setError(filterError instanceof Error ? filterError.message : "Kunne ikke opdatere filtre");
        } finally {
            setBusy(false);
        }
    }

    async function handleDateRangeChange(next: { dateFrom?: string; dateTo?: string }): Promise<void> {
        const nextDateFrom = next.dateFrom ?? dateFrom;
        const nextDateTo = next.dateTo ?? dateTo;
        setDateFrom(nextDateFrom);
        setDateTo(nextDateTo);
        setBusy(true);
        setError(null);
        try {
            await loadDashboard({
                dateFrom: nextDateFrom,
                dateTo: nextDateTo,
                merchantKeys: selectedMerchantKeys,
                tab: selectedTab,
                itemSearch,
            });
        } catch (filterError) {
            setError(filterError instanceof Error ? filterError.message : "Kunne ikke opdatere filtre");
        } finally {
            setBusy(false);
        }
    }

    async function handleItemSearchSubmit(): Promise<void> {
        setBusy(true);
        setError(null);
        try {
            setItemSearch(itemSearchInput);
            await loadDashboard({ itemSearch: itemSearchInput });
        } catch (searchError) {
            setError(searchError instanceof Error ? searchError.message : "Kunne ikke søge varer");
        } finally {
            setBusy(false);
        }
    }

    async function handleGranularityChange(nextGranularity: "month" | "year"): Promise<void> {
        setGranularity(nextGranularity);
        setBusy(true);
        setError(null);
        try {
            await loadDashboard({ granularity: nextGranularity, tab: "oversigt" });
        } catch (overviewError) {
            setError(overviewError instanceof Error ? overviewError.message : "Kunne ikke hente oversigt");
        } finally {
            setBusy(false);
        }
    }

    async function handleOpenOverviewSunburst(title: string, periods: string[]): Promise<void> {
        if (periods.length === 0) {
            return;
        }
        setOverviewSunburstState({ title, periods, response: null });
        try {
            const response = await getKvitteringerOverviewSunburst(granularity, periods, {
                merchantKeys: selectedMerchantKeys.length > 0 ? selectedMerchantKeys : undefined,
            });
            setOverviewSunburstState({ title, periods, response });
        } catch (sunburstError) {
            clearOverviewSunburst();
            setError(sunburstError instanceof Error ? sunburstError.message : "Kunne ikke hente sunburst");
        }
    }

    async function handleTabChange(nextTab: KvitteringerTab): Promise<void> {
        if (nextTab === selectedTab) {
            return;
        }
        setSelectedTab(nextTab);
        setBusy(true);
        setError(null);
        try {
            await loadDashboard({ tab: nextTab });
        } catch (tabError) {
            setError(tabError instanceof Error ? tabError.message : "Kunne ikke skifte visning");
        } finally {
            setBusy(false);
        }
    }

    useEffect(() => {
        if (!overviewSunburstGraphDiv || !overviewSunburstFigure || !overviewSunburstState?.response) {
            return;
        }

        const handleOverviewSunburstPlotlyClick = (event: any): void => {
            const nodeId = String(event?.points?.[0]?.id ?? "");
            if (!nodeId) {
                return;
            }
            const clusterId = overviewSunburstFigure.itemClusterIds[nodeId];
            if (!clusterId) {
                return;
            }
            void handleSelectItem(clusterId, "oversigt");
        };

        if (typeof overviewSunburstGraphDiv.on !== "function") {
            return;
        }

        overviewSunburstGraphDiv.on("plotly_click", handleOverviewSunburstPlotlyClick);
        return () => {
            if (typeof overviewSunburstGraphDiv.removeListener === "function") {
                overviewSunburstGraphDiv.removeListener("plotly_click", handleOverviewSunburstPlotlyClick);
            }
        };
    }, [overviewSunburstFigure, overviewSunburstGraphDiv, overviewSunburstState]);

    function handleToggleMerchantSelection(merchantKey: string): void {
        setSelectedMerchantKeys((current) => current.includes(merchantKey)
            ? current.filter((value) => value !== merchantKey)
            : [...current, merchantKey]);
    }

    function handleSelectAllMerchants(): void {
        setSelectedMerchantKeys([]);
    }

    async function handleSelectReceipt(
        receiptId: string,
        context: DetailContext = selectedTab === "varer" ? "varer" : selectedTab === "oversigt" ? "oversigt" : "kvitteringer"
    ): Promise<void> {
        setReceiptLoading(true);
        setError(null);
        try {
            const preserveItemSelection = context === "varer" && showReceiptSidePanel && selectedTab === "varer";
            if (!preserveItemSelection) {
                clearSelectedItemDetail();
            }
            setSelectedReceiptContext(context);
            setSelectedReceipt(await getKvitteringerReceipt(receiptId));
        } catch (receiptError) {
            setError(receiptError instanceof Error ? receiptError.message : "Kunne ikke hente kvittering");
        } finally {
            setReceiptLoading(false);
        }
    }

    async function handleSelectItem(
        clusterId: string,
        context: DetailContext = selectedTab === "varer" ? "varer" : selectedTab === "oversigt" ? "oversigt" : "kvitteringer"
    ): Promise<void> {
        setItemLoading(true);
        setError(null);
        try {
            const preserveReceiptSelection = context === "kvitteringer" && showReceiptSidePanel && selectedTab === "kvitteringer";
            if (!preserveReceiptSelection) {
                clearSelectedReceiptDetail();
            }
            setSelectedItemContext(context);
            await refreshSelectedItem(clusterId, filtersForContext(context, dateFrom, dateTo, selectedMerchantKeys));
        } catch (itemError) {
            setError(itemError instanceof Error ? itemError.message : "Kunne ikke hente varehistorik");
        } finally {
            setItemLoading(false);
        }
    }

    async function handleSaveItemCategoryOverride(categoryKey: string | null): Promise<void> {
        if (!selectedItem) {
            return;
        }
        setItemCategorySaving(true);
        setError(null);
        try {
            const nextDetail = await saveKvitteringerItemCategoryOverride(selectedItem.cluster.cluster_id, categoryKey);
            setSelectedItem(nextDetail);
            setItemCategoryDraft(nextDetail.cluster.category_key);
            await loadDashboard({
                granularity,
                dateFrom,
                dateTo,
                merchantKeys: selectedMerchantKeys,
                tab: selectedTab,
                itemSearch,
            });
        } catch (itemCategoryError) {
            setError(itemCategoryError instanceof Error ? itemCategoryError.message : "Kunne ikke gemme varegruppe");
        } finally {
            setItemCategorySaving(false);
        }
    }

    async function handleSelectMerchant(merchantKeyValue: string, context: DetailContext = "oversigt"): Promise<void> {
        setMerchantLoading(true);
        setError(null);
        try {
            setSelectedMerchantContext(context);
            await refreshSelectedMerchantDetail(
                merchantKeyValue,
                filtersForContext(context, dateFrom, dateTo, [merchantKeyValue])
            );
        } catch (merchantError) {
            setError(merchantError instanceof Error ? merchantError.message : "Kunne ikke hente butiksdetaljer");
        } finally {
            setMerchantLoading(false);
        }
    }

    async function handleMerchantShortcut(nextMerchantKey: string): Promise<void> {
        setSelectedMerchantKeys([nextMerchantKey]);
        setSelectedTab("kvitteringer");
        setBusy(true);
        setError(null);
        try {
            await loadDashboard({ merchantKeys: [nextMerchantKey], tab: "kvitteringer" });
        } catch (merchantError) {
            setError(merchantError instanceof Error ? merchantError.message : "Kunne ikke filtrere butik");
        } finally {
            setBusy(false);
        }
    }

    const toolbarStatus = status
        ? `${status.receipt_count} kvitteringer`
        : null;
    const activeReceiptSidePanel = showReceiptSidePanel && selectedTab === "kvitteringer" && selectedReceiptContext === "kvitteringer";
    const showMerchantSidePanel = showReceiptSidePanel && selectedTab === "oversigt" && selectedMerchantContext === "oversigt";
    const showItemSidePanel = showReceiptSidePanel && selectedTab === "varer" && selectedItemContext === "varer";
    const itemModalLoading = itemLoading || (busy && !!selectedItem);
    const merchantDetailLoading = merchantLoading || (busy && !!selectedMerchantDetail);
    const showOverviewSunburstItemPanel = !!overviewSunburstState && selectedTab === "oversigt" && selectedItemContext === "oversigt" && (itemModalLoading || !!selectedItem);
    const showItemModal = selectedItemContext === selectedTab && !showItemSidePanel && !showOverviewSunburstItemPanel && (itemModalLoading || !!selectedItem);
    const selectedItemCategoryOptions = selectedItem?.category_options ?? [];
    const itemCategoryDirty = !!selectedItem && itemCategoryDraft !== selectedItem.cluster.category_key;
    const canResetItemCategory = !!selectedItem?.cluster.category_is_override;
    const showReceiptModal = selectedReceiptContext === selectedTab && !activeReceiptSidePanel && (receiptLoading || !!selectedReceipt);
    const showMerchantModal = selectedMerchantContext === selectedTab && !showMerchantSidePanel && (merchantDetailLoading || !!selectedMerchantDetail);

    const renderLoadingOverlay = (label: string) => (
        <div className="kvitteringer-loading-overlay" role="status" aria-live="polite" aria-label={label}>
            <span className="kvitteringer-spinner" aria-hidden="true" />
            <span>{label}</span>
        </div>
    );

    const renderOverviewLabel = (row: KvitteringerOverviewRow) => {
        if (row.kind === "merchant" && row.merchantKey) {
            return (
                <button
                    type="button"
                    className="kvitteringer-overview-label-button"
                    onClick={() => void handleSelectMerchant(row.merchantKey as string, "oversigt")}
                    title={row.label}
                >
                    {row.label}
                </button>
            );
        }
        if (row.kind === "item" && row.clusterId) {
            return (
                <button
                    type="button"
                    className="kvitteringer-overview-label-button"
                    onClick={() => void handleSelectItem(row.clusterId as string, "oversigt")}
                    title={row.label}
                >
                    {row.label}
                </button>
            );
        }
        return <span className="spiir-label-text" title={row.label}>{row.label}</span>;
    };

    const renderOverviewValue = (row: KvitteringerOverviewRow, value: number, key: string) => {
        if (row.kind === "merchant" && row.merchantKey) {
            return (
                <button
                    key={key}
                    type="button"
                    className={`spiir-cell-button ${valueToneClass(value)}`}
                    onClick={() => void handleSelectMerchant(row.merchantKey as string, "oversigt")}
                >
                    {formatMinor(value)}
                </button>
            );
        }
        if (row.kind === "item" && row.clusterId) {
            return (
                <button
                    key={key}
                    type="button"
                    className={`spiir-cell-button ${valueToneClass(value)}`}
                    onClick={() => void handleSelectItem(row.clusterId as string, "oversigt")}
                >
                    {formatMinor(value)}
                </button>
            );
        }
        return <span key={key} className={`kvitteringer-overview-value ${valueToneClass(value)}`}>{formatMinor(value)}</span>;
    };

    const receiptDetailContent = selectedReceipt ? (
        <>
            <div className="panel-header compact-header">
                <div>
                    <h2>{selectedReceipt.receipt.merchant_name} - {formatDateTime(selectedReceipt.receipt.purchase_timestamp)}</h2>
                </div>
                {!activeReceiptSidePanel ? (
                    <button type="button" className="secondary-button" onClick={() => clearSelectedReceiptDetail()}>
                        Luk
                    </button>
                ) : null}
            </div>

            <section className="kvitteringers-receipt-card">
                <div className="kvitteringers-receipt-footer kvitteringers-receipt-summary-top">
                    <div>
                        <span>Varer i alt</span>
                        <strong>{formatMinor(selectedReceipt.receipt.parsed_item_total_minor)}</strong>
                    </div>
                    <div>
                        <span>Rabat i alt</span>
                        <strong>{formatMinor(selectedReceiptDiscountTotalMinor)}</strong>
                    </div>
                    {selectedReceipt.receipt.unassigned_discount_total_minor > 0 ? (
                        <div>
                            <span>Uafklaret rabat</span>
                            <strong>{formatMinor(selectedReceipt.receipt.unassigned_discount_total_minor)}</strong>
                        </div>
                    ) : null}
                    {selectedReceipt.receipt.gap_minor !== 0 ? (
                        <div>
                            <span>Gap</span>
                            <strong>{formatMinor(selectedReceipt.receipt.gap_minor)}</strong>
                        </div>
                    ) : null}
                    <div className="kvitteringers-receipt-footer-total">
                        <span>Total</span>
                        <strong>{formatMinor(selectedReceipt.receipt.receipt_total_minor)}</strong>
                    </div>
                </div>

                <div className="kvitteringers-receipt-list">
                    {selectedReceipt.occurrences.map((occurrence) => (
                        <button
                            key={occurrence.occurrence_id}
                            type="button"
                            className="kvitteringers-receipt-line"
                            onClick={() => void handleSelectItem(occurrence.cluster_id, "kvitteringer")}
                        >
                            <span className="kvitteringers-receipt-line-main">
                                <strong>{occurrence.display_name}</strong>
                                <span>{formatMinor(occurrence.net_total_minor)}</span>
                            </span>
                            <span className="kvitteringers-receipt-line-meta">
                                <span>{formatUnitSummary(occurrence)}</span>
                                <span>{occurrence.discount_minor > 0 ? `Rabat ${formatMinor(occurrence.discount_minor)}` : ""}</span>
                            </span>
                        </button>
                    ))}
                </div>
            </section>
        </>
    ) : null;

    const receiptDetailSurface = (
        <div className="kvitteringer-loading-shell">
            {receiptDetailContent ?? (
                <div className="kvitteringer-empty-detail">
                    <h3>{receiptLoading ? "Henter kvittering" : "Vælg en kvittering"}</h3>
                    <p>{receiptLoading ? "Opdaterer kvitteringsoversigt." : "Klik på en række for at se kvitteringsoversigt her."}</p>
                </div>
            )}
            {receiptLoading ? renderLoadingOverlay("Henter kvittering...") : null}
        </div>
    );

    const itemDetailContent = selectedItem ? (
        <>
            <div className="panel-header compact-header">
                <div>
                    <p className="eyebrow">Vare</p>
                    <h2>{selectedItem.cluster.preferred_display_name}</h2>
                    <span>{selectedItem.aliases.length} aliaser og {selectedItemPricePoints.length} prispunkter</span>
                </div>
                {!showItemSidePanel ? (
                    <button type="button" className="secondary-button" onClick={() => clearSelectedItemDetail()}>
                        Luk
                    </button>
                ) : null}
            </div>

            <dl className="kvitteringer-item-summary-grid">
                <div>
                    <dt>Klyngestrategi</dt>
                    <dd>{selectedItem.cluster.collapse_strategy}</dd>
                </div>
                <div>
                    <dt>Confidence</dt>
                    <dd>{selectedItem.cluster.confidence}</dd>
                </div>
                <div>
                    <dt>Første køb</dt>
                    <dd>{formatDate(selectedItem.cluster.first_purchase_date)}</dd>
                </div>
                <div>
                    <dt>Seneste køb</dt>
                    <dd>{formatDate(selectedItem.cluster.last_purchase_date)}</dd>
                </div>
                <div>
                    <dt>Snit stk pris</dt>
                    <dd>{formatMinor(selectedItem.cluster.avg_unit_price_minor)}</dd>
                </div>
                <div>
                    <dt>Min/max</dt>
                    <dd>{formatMinor(selectedItem.cluster.min_unit_price_minor ?? null)} / {formatMinor(selectedItem.cluster.max_unit_price_minor ?? null)}</dd>
                </div>
            </dl>

            <section className="kvitteringer-item-category-editor">
                <div>
                    <h3>Varegruppe</h3>
                    <p className="intro">
                        {selectedItem.cluster.category_label} · {formatCategorySource(selectedItem.cluster.category_source, selectedItem.cluster.category_is_override)} · sikkerhed {selectedItem.cluster.category_confidence}
                    </p>
                </div>
                <div className="kvitteringer-item-category-controls">
                    <label className="kvitteringer-item-category-field">
                        <span>Flyt til gruppe</span>
                        <select
                            value={itemCategoryDraft}
                            onChange={(event) => setItemCategoryDraft(event.target.value)}
                            disabled={itemCategorySaving}
                        >
                            {selectedItemCategoryOptions.map((option: KvitteringerCategoryOption) => (
                                <option key={option.key} value={option.key}>{option.label}</option>
                            ))}
                        </select>
                    </label>
                    <div className="kvitteringer-detail-actions">
                        <button
                            type="button"
                            className="secondary-button"
                            onClick={() => void handleSaveItemCategoryOverride(itemCategoryDraft || null)}
                            disabled={!itemCategoryDirty || itemCategorySaving}
                        >
                            {itemCategorySaving ? "Gemmer..." : "Gem gruppe"}
                        </button>
                        <button
                            type="button"
                            className="secondary-button"
                            onClick={() => void handleSaveItemCategoryOverride(null)}
                            disabled={!canResetItemCategory || itemCategorySaving}
                        >
                            Nulstil auto
                        </button>
                    </div>
                </div>
            </section>

            <ul className="kvitteringer-alias-list">
                {selectedItem.aliases.map((alias: KvitteringerItemAlias) => (
                    <li key={`${alias.raw_name}-${alias.variant_signature}`}>{alias.raw_name}</li>
                ))}
            </ul>

            <div className="kvitteringer-item-subgrid">
                <section className="kvitteringer-inline-panel">
                    <h3>Butikfordeling</h3>
                    <div className="kvitteringer-table-scroll kvitteringer-table-scroll-short">
                        <table className="kvitteringer-table">
                            <thead>
                                <tr>
                                    <th>Butik</th>
                                    <th>Køb</th>
                                    <th>Spend</th>
                                    <th>Min/max pris</th>
                                </tr>
                            </thead>
                            <tbody>
                                {selectedItemMerchantBreakdown.map((merchant) => (
                                    <tr key={merchant.merchantKey} className="kvitteringer-click-row" onClick={() => void handleMerchantShortcut(merchant.merchantKey)}>
                                        <td>{merchant.merchantName}</td>
                                        <td>{merchant.purchaseCount}</td>
                                        <td>{formatMinor(merchant.spendMinor)}</td>
                                        <td>{formatMinor(merchant.minUnitPriceMinor)} / {formatMinor(merchant.maxUnitPriceMinor)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </section>

                <section className="kvitteringers-inline-panel">
                    <h3>Prisforløb</h3>
                    {selectedItemPricePoints.length > 0 ? (
                        <div className="kvitteringer-price-chart-card">
                            <div className="kvitteringer-price-chart-meta">
                                <span>Lav {formatMinor(priceChartMin)}</span>
                                <span>Senest {latestPricePoint ? formatMinor(latestPricePoint.unitPriceMinor) : "-"}</span>
                                <span>Høj {formatMinor(priceChartMax)}</span>
                            </div>
                            <div className="kvitteringer-price-chart">
                                <Plot data={priceChartTrace as never} layout={priceChartLayout as never} config={priceChartConfig} useResizeHandler className="kvitteringer-price-chart-plot" />
                            </div>
                            <div className="kvitteringer-price-chart-foot">
                                <span>{formatDate(selectedItemPricePoints[0]?.purchaseDate)}</span>
                                <span>{formatDate(selectedItemPricePoints[selectedItemPricePoints.length - 1]?.purchaseDate)}</span>
                            </div>
                        </div>
                    ) : (
                        <p className="intro">Ingen prispunkter endnu.</p>
                    )}
                </section>
            </div>

            <div className="kvitteringers-table-scroll">
                <table className="kvitteringer-table">
                    <thead>
                        <tr>
                            <th>Dato</th>
                            <th>Butik</th>
                            <th>Navn</th>
                            <th>Stk pris</th>
                            <th>Netto</th>
                            <th>Rabat</th>
                            <th>Mængde</th>
                        </tr>
                    </thead>
                    <tbody>
                        {[...selectedItemHistory].reverse().map((occurrence) => (
                            <tr key={occurrence.occurrence_id} className="kvitteringers-click-row" onClick={() => void handleSelectReceipt(occurrence.receipt_id, "varer")}>
                                <td>{formatDate(occurrence.purchase_date)}</td>
                                <td>{occurrence.merchant_name ?? occurrence.merchant_key}</td>
                                <td>{occurrence.display_name}</td>
                                <td>{formatMinor(occurrence.unit_price_minor ?? null)}</td>
                                <td>{formatMinor(occurrence.net_total_minor)}</td>
                                <td>{formatMinor(occurrence.discount_minor)}</td>
                                <td>{formatQuantity(occurrence.quantity)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </>
    ) : null;

    const itemDetailSurface = (
        <div className="kvitteringer-loading-shell">
            {itemDetailContent ?? (
                <div className="kvitteringer-empty-detail">
                    <h3>{itemModalLoading ? "Henter vare" : "Vælg en vare"}</h3>
                    <p>{itemModalLoading ? "Opdaterer varehistorik, butikfordeling og prisforløb." : "Klik på en række til venstre for at se historik, butikfordeling og prisforløb her."}</p>
                </div>
            )}
            {itemModalLoading ? renderLoadingOverlay("Henter vare...") : null}
        </div>
    );

    const merchantDetailContent = selectedMerchantDetail ? (
        <>
            <div className="panel-header compact-header">
                <div>
                    <p className="eyebrow">Butik</p>
                    <h2>{selectedMerchantDetail.merchant.display_name}</h2>
                    <span>{selectedMerchantDetail.receipts.length} kvitteringer og {selectedMerchantDetail.items.length} varer i valgt filter</span>
                </div>
                <div className="kvitteringer-detail-actions">
                    <button
                        type="button"
                        className="secondary-button"
                        onClick={() => void handleMerchantShortcut(selectedMerchantDetail.merchant.merchant_key)}
                    >
                        Åbn filtreret
                    </button>
                    <button type="button" className="secondary-button" onClick={() => clearSelectedMerchantDetail()}>
                        Luk
                    </button>
                </div>
            </div>

            <dl className="kvitteringer-item-summary-grid">
                <div>
                    <dt>Spend</dt>
                    <dd>{formatMinor(selectedMerchantDetail.merchant.spend_minor)}</dd>
                </div>
                <div>
                    <dt>Kurv-snit</dt>
                    <dd>{formatMinor(selectedMerchantDetail.merchant.average_basket_minor)}</dd>
                </div>
                <div>
                    <dt>Rabat</dt>
                    <dd>{formatMinor(selectedMerchantDetail.merchant.attributed_discount_minor)}</dd>
                </div>
                <div>
                    <dt>Uafklaret rabat</dt>
                    <dd>{formatMinor(selectedMerchantDetail.merchant.unassigned_discount_minor)}</dd>
                </div>
                <div>
                    <dt>Varediversitet</dt>
                    <dd>{selectedMerchantDetail.merchant.item_diversity}</dd>
                </div>
                <div>
                    <dt>Kvitteringer</dt>
                    <dd>{selectedMerchantDetail.merchant.receipt_count}</dd>
                </div>
            </dl>

            <div className="kvitteringer-item-subgrid">
                <section className="kvitteringers-inline-panel">
                    <h3>Topvarer</h3>
                    <div className="kvitteringers-table-scroll kvitteringers-table-scroll-short">
                        <table className="kvitteringers-table">
                            <thead>
                                <tr>
                                    <th>Vare</th>
                                    <th>Mængde</th>
                                    <th>Spend</th>
                                    <th>Snit stk</th>
                                </tr>
                            </thead>
                            <tbody>
                                {selectedMerchantDetail.items.slice(0, 12).map((item) => (
                                    <tr
                                        key={item.cluster_id}
                                        className="kvitteringers-click-row"
                                        onClick={() => void handleSelectItem(item.cluster_id, "oversigt")}
                                    >
                                        <td>{item.preferred_display_name}</td>
                                        <td>{formatQuantity(item.quantity_total)}</td>
                                        <td>{formatMinor(item.net_spend_minor)}</td>
                                        <td>{formatMinor(item.avg_unit_price_minor)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </section>

                <section className="kvitteringers-inline-panel">
                    <h3>Seneste kvitteringer</h3>
                    <div className="kvitteringers-table-scroll kvitteringers-table-scroll-short">
                        <table className="kvitteringers-table">
                            <thead>
                                <tr>
                                    <th>Dato</th>
                                    <th>Total</th>
                                    <th>Rabat</th>
                                </tr>
                            </thead>
                            <tbody>
                                {selectedMerchantDetail.receipts.slice(0, 12).map((receipt) => (
                                    <tr
                                        key={receipt.receipt_id}
                                        className="kvitteringers-click-row"
                                        onClick={() => void handleSelectReceipt(receipt.receipt_id, "oversigt")}
                                    >
                                        <td>{formatDateTime(receipt.purchase_timestamp)}</td>
                                        <td>{formatMinor(receipt.receipt_total_minor)}</td>
                                        <td>{formatMinor(receipt.attributed_discount_total_minor + receipt.unassigned_discount_total_minor)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </section>
            </div>
        </>
    ) : null;

    const merchantDetailSurface = (
        <div className="kvitteringer-loading-shell">
            {merchantDetailContent ?? (
                <div className="kvitteringer-empty-detail">
                    <h3>{merchantDetailLoading ? "Henter butik" : "Vælg en butik"}</h3>
                    <p>{merchantDetailLoading ? "Opdaterer butiksdetaljer, topvarer og kvitteringer." : "Klik på en butik i oversigten for at se detailpanelet her."}</p>
                </div>
            )}
            {merchantDetailLoading ? renderLoadingOverlay("Henter butik...") : null}
        </div>
    );

    return (
        <section className="kvitteringer-shell">
            <section className="panel kvitteringer-toolbar-panel">
                <div className="kvitteringer-toolbar-row">
                    <div className="scope-switcher" aria-label="Vælg kvitteringsvisning">
                        {(["oversigt", "varer", "butikker", "kvitteringer"] as KvitteringerTab[]).map((tab) => (
                            <button
                                key={tab}
                                type="button"
                                className={selectedTab === tab ? "nav-pill active" : "nav-pill"}
                                onClick={() => void handleTabChange(tab)}
                            >
                                {tab === "oversigt" ? "Oversigt" : tab === "varer" ? "Varer" : tab === "butikker" ? "Butikker" : "Kvitteringer"}
                            </button>
                        ))}
                    </div>

                    <div className="kvitteringer-toolbar-actions">
                        {selectedTab === "oversigt" ? (
                            <>
                                <div className="scope-switcher kvitteringer-compact-toggle" aria-label="Vælg periode">
                                    <button type="button" className={granularity === "month" ? "nav-pill active" : "nav-pill"} onClick={() => void handleGranularityChange("month")}>
                                        Måned
                                    </button>
                                    <button type="button" className={granularity === "year" ? "nav-pill active" : "nav-pill"} onClick={() => void handleGranularityChange("year")}>
                                        År
                                    </button>
                                </div>
                                <label className="kvitteringer-filter-field kvitteringer-filter-field-compact">
                                    <span>Vindue</span>
                                    <select
                                        value={overviewCurrentWindow}
                                        onChange={(event) => {
                                            if (granularity === "month") {
                                                setOverviewMonthWindow(event.target.value);
                                            } else {
                                                setOverviewYearWindow(event.target.value);
                                            }
                                        }}
                                    >
                                        {overviewWindowOptions.map((option) => (
                                            <option key={option.value} value={option.value}>{option.label}</option>
                                        ))}
                                    </select>
                                </label>
                                <div className="scope-switcher spiir-toggle-group" aria-label="Oversigt toggles">
                                    <OverviewTogglePill
                                        label="Skip sidste"
                                        active={overviewExcludeLatest}
                                        onClick={() => {
                                            if (granularity === "month") {
                                                setExcludeLatestMonth((current) => !current);
                                            } else {
                                                setExcludeLatestYear((current) => !current);
                                            }
                                        }}
                                    />
                                    <OverviewTogglePill
                                        label="Flat"
                                        active={overviewMode === "flat"}
                                        onClick={() => setOverviewMode((current) => current === "flat" ? "grouped" : "flat")}
                                    />
                                </div>
                                <label className="kvitteringer-filter-field kvitteringer-filter-field-compact">
                                    <span>Varer</span>
                                    <select value={overviewItemLimit} onChange={(event) => setOverviewItemLimit(event.target.value === "all" ? "all" : "50")}>
                                        <option value="50">Top 50</option>
                                        <option value="all">Alle</option>
                                    </select>
                                </label>
                            </>
                        ) : null}

                        <div className="kvitteringer-filter-row">
                            {selectedTab !== "oversigt" ? (
                                <>
                                    <label className="kvitteringer-filter-field kvitteringer-filter-field-compact">
                                        <span>Fra</span>
                                        <input type="date" value={dateFrom} onChange={(event) => void handleDateRangeChange({ dateFrom: event.target.value })} />
                                    </label>
                                    <label className="kvitteringer-filter-field kvitteringer-filter-field-compact">
                                        <span>Til</span>
                                        <input type="date" value={dateTo} onChange={(event) => void handleDateRangeChange({ dateTo: event.target.value })} />
                                    </label>
                                </>
                            ) : null}
                            <label className="kvitteringer-filter-field kvitteringer-filter-field-wide kvitteringer-filter-field-compact">
                                <span>Butikker</span>
                                <details className="kvitteringer-multiselect" ref={merchantSelectRef}>
                                    <summary>{merchantSelectionLabel}</summary>
                                    <div className="kvitteringer-multiselect-menu">
                                        <div className="kvitteringer-multiselect-actions">
                                            <button
                                                type="button"
                                                className="secondary-button kvitteringer-multiselect-action"
                                                onClick={(event) => {
                                                    event.preventDefault();
                                                    handleSelectAllMerchants();
                                                }}
                                            >
                                                Vælg alle
                                            </button>
                                        </div>
                                        <div className="kvitteringer-multiselect-options">
                                            {sortedMerchantOptions.map((merchant) => (
                                                <label key={merchant.merchant_key} className="kvitteringer-multiselect-option">
                                                    <input
                                                        type="checkbox"
                                                        checked={selectedMerchantKeys.includes(merchant.merchant_key)}
                                                        onChange={() => handleToggleMerchantSelection(merchant.merchant_key)}
                                                    />
                                                    <span>{merchant.display_name}</span>
                                                    <span className="kvitteringer-multiselect-count">{merchant.receipt_count}</span>
                                                </label>
                                            ))}
                                        </div>
                                    </div>
                                </details>
                            </label>
                            {selectedTab === "varer" ? (
                                <div className="kvitteringer-search-wrap kvitteringer-search-wrap-compact">
                                    <input
                                        type="search"
                                        value={itemSearchInput}
                                        onChange={(event) => setItemSearchInput(event.target.value)}
                                        placeholder="Søg vare"
                                    />
                                    <button type="button" className="secondary-button" onClick={() => void handleItemSearchSubmit()} disabled={busy}>
                                        Søg
                                    </button>
                                </div>
                            ) : null}
                            {selectedTab === "kvitteringer" ? (
                                <div className="kvitteringer-search-wrap kvitteringer-search-wrap-compact">
                                    <input
                                        type="search"
                                        value={receiptSearch}
                                        onChange={(event) => setReceiptSearch(event.target.value)}
                                        placeholder="Filtrér kvitteringer"
                                    />
                                </div>
                            ) : null}
                        </div>

                        <div className="kvitteringer-toolbar-side">
                            {toolbarStatus ? <span className="kvitteringer-toolbar-meta">{toolbarStatus}</span> : null}
                            <input
                                ref={uploadInputRef}
                                type="file"
                                accept=".json,application/json"
                                hidden
                                onChange={(event) => void handleStoreboxUploadChange(event)}
                            />
                            <button type="button" className="secondary-button" onClick={() => uploadInputRef.current?.click()} disabled={busy}>
                                Upload ny JSON
                            </button>
                            <button type="button" className="secondary-button" onClick={() => void handleImport("rebuild")} disabled={busy}>
                                Rebuild
                            </button>
                            <button type="button" className="primary-button" onClick={() => void handleImport("import")} disabled={busy}>
                                Importér mappe
                            </button>
                        </div>
                    </div>
                </div>
                {error ? <p className="error-banner">{error}</p> : null}
            </section>

            {selectedTab === "oversigt" ? (
                <div className={showMerchantSidePanel ? "kvitteringer-receipts-layout" : undefined}>
                    <section className="panel kvitteringer-panel">
                        <div className="panel-header compact-header">
                            <div>
                                <h2>Oversigt</h2>
                                <span>
                                    {visibleOverviewPeriods.length > 0
                                        ? `${overviewVisibleReceiptCount} kvitteringer · ${formatMinor(overviewVisibleSpendMinor)} i vinduet`
                                        : "Vælg et bredere vindue eller slå Skip sidste fra"}
                                </span>
                            </div>
                        </div>
                        <div className="kvitteringer-loading-shell">
                            {visibleOverviewPeriods.length === 0 ? (
                                <div className="kvitteringer-empty-detail">
                                    <h3>Ingen perioder i vinduet</h3>
                                    <p>Udvid vinduet eller slå Skip sidste fra for at se perioder igen.</p>
                                </div>
                            ) : (
                                <div className="spiir-table-scroll">
                                    <table className="spiir-table">
                                        <thead>
                                            <tr>
                                                <th className="spiir-sticky">
                                                    {overviewExpandableKeys.length > 0 ? (
                                                        <button
                                                            type="button"
                                                            className="spiir-pill-toggle spiir-table-expand-pill"
                                                            onClick={() => setExpandedOverviewRows(overviewAllExpanded ? new Set() : new Set(overviewExpandableKeys))}
                                                        >
                                                            {overviewAllExpanded ? "Fold" : "Udvid"}
                                                        </button>
                                                    ) : (
                                                        <span>Rækker</span>
                                                    )}
                                                </th>
                                                {visibleOverviewPeriods.map((period) => (
                                                    <th key={period}>
                                                        <button
                                                            type="button"
                                                            className="spiir-th-button"
                                                            onClick={() => void handleOpenOverviewSunburst(`${overviewTitle} · ${period}`, [period])}
                                                        >
                                                            {period}
                                                        </button>
                                                    </th>
                                                ))}
                                                <th>
                                                    <button
                                                        type="button"
                                                        className="spiir-th-button"
                                                        disabled={visibleOverviewPeriods.length === 0}
                                                        onClick={() => void handleOpenOverviewSunburst(`${overviewTitle} · I alt`, visibleOverviewPeriods)}
                                                    >
                                                        I alt
                                                    </button>
                                                </th>
                                                <th>Snit</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {overviewVisibleRows.map((row) => {
                                                const expandable = hasOverviewChildren(overviewRows, row.key);
                                                const total = rowTotalForPeriods(row.values, visibleOverviewPeriods);
                                                const avg = rowAvgForPeriods(row.values, visibleOverviewPeriods);
                                                return (
                                                    <tr key={row.key} className={`spiir-row spiir-level-${row.level}`}>
                                                        <td className="spiir-sticky spiir-label-cell">
                                                            <div className="spiir-label-wrap">
                                                                {expandable ? (
                                                                    <button
                                                                        type="button"
                                                                        className="spiir-expand-toggle"
                                                                        onClick={() => setExpandedOverviewRows((current) => {
                                                                            const next = new Set(current);
                                                                            if (next.has(row.key)) {
                                                                                next.delete(row.key);
                                                                            } else {
                                                                                next.add(row.key);
                                                                            }
                                                                            return next;
                                                                        })}
                                                                    >
                                                                        {expandedOverviewRows.has(row.key) ? "−" : "+"}
                                                                    </button>
                                                                ) : null}
                                                                {renderOverviewLabel(row)}
                                                            </div>
                                                        </td>
                                                        {visibleOverviewPeriods.map((period) => (
                                                            <td key={`${row.key}-${period}`}>
                                                                {renderOverviewValue(row, Number(row.values[period] ?? 0), `${row.key}-${period}`)}
                                                            </td>
                                                        ))}
                                                        <td>{renderOverviewValue(row, total, `${row.key}-total`)}</td>
                                                        <td>
                                                            <span className={`kvitteringer-overview-value ${valueToneClass(avg)}`}>{formatMinor(avg)}</span>
                                                        </td>
                                                    </tr>
                                                );
                                            })}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                            {busy ? renderLoadingOverlay("Opdaterer oversigt...") : null}
                        </div>
                    </section>

                    {showMerchantSidePanel ? (
                        <section className="panel kvitteringer-panel kvitteringer-item-side-panel kvitteringer-merchant-side-panel">
                            {merchantDetailSurface}
                        </section>
                    ) : null}
                </div>
            ) : null}

            {selectedTab === "butikker" ? (
                <section className="panel kvitteringer-panel">
                    <div className="panel-header compact-header">
                        <div>
                            <h2>Butikker</h2>
                            <span>Klik på en butik for at filtrere resten af visningen</span>
                        </div>
                    </div>
                    <div className="kvitteringer-loading-shell">
                        <div className="kvitteringer-table-scroll">
                            <table className="kvitteringer-table">
                                <thead>
                                    <tr>
                                        <th>Butik</th>
                                        <th>Kvitteringer</th>
                                        <th>Spend</th>
                                        <th>Kurv-snit</th>
                                        <th>Varediversitet</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {merchants.map((merchant) => (
                                        <tr key={merchant.merchant_key} className="kvitteringer-click-row" onClick={() => void handleMerchantShortcut(merchant.merchant_key)}>
                                            <td>{merchant.display_name}</td>
                                            <td>{merchant.receipt_count}</td>
                                            <td>{formatMinor(merchant.spend_minor)}</td>
                                            <td>{formatMinor(merchant.average_basket_minor)}</td>
                                            <td>{merchant.item_diversity}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        {busy ? renderLoadingOverlay("Opdaterer butikker...") : null}
                    </div>
                </section>
            ) : null}

            {selectedTab === "varer" ? (
                <div className={showItemSidePanel ? "kvitteringer-receipts-layout" : undefined}>
                    <section className="panel kvitteringer-panel">
                        <div className="panel-header compact-header">
                            <div>
                                <h2>Varer</h2>
                                <span>Klik for historik, butikfordeling og prisforløb</span>
                            </div>
                        </div>
                        <div className="kvitteringer-loading-shell">
                            <div className="kvitteringer-table-frame">
                                <table className="kvitteringer-table">
                                    <thead>
                                        <tr>
                                            <th>Vare</th>
                                            <th>Varegruppe</th>
                                            <th>Mængde</th>
                                            <th>Kvitteringer</th>
                                            <th>Netto spend</th>
                                            <th>Snit stk</th>
                                            <th>Min pris</th>
                                            <th>Max pris</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {items.map((item) => (
                                            <tr key={item.cluster_id} className="kvitteringer-click-row" onClick={() => void handleSelectItem(item.cluster_id, "varer")}>
                                                <td>{item.preferred_display_name}</td>
                                                <td>{item.category_label}</td>
                                                <td>{formatQuantity(item.quantity_total)}</td>
                                                <td>{item.receipt_count}</td>
                                                <td>{formatMinor(item.net_spend_minor)}</td>
                                                <td>{formatMinor(item.avg_unit_price_minor)}</td>
                                                <td>{formatMinor(item.min_unit_price_minor ?? null)}</td>
                                                <td>{formatMinor(item.max_unit_price_minor ?? null)}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                            {busy ? renderLoadingOverlay("Opdaterer varer...") : null}
                        </div>
                    </section>

                    {showItemSidePanel ? (
                        <section ref={itemSidePanelRef} className="panel kvitteringer-panel kvitteringer-item-side-panel">
                            {itemDetailSurface}
                        </section>
                    ) : null}
                </div>
            ) : null}

            {selectedTab === "kvitteringer" ? (
                <div className={showReceiptSidePanel ? "kvitteringer-receipts-layout" : undefined}>
                    <section className="panel kvitteringer-panel">
                        <div className="panel-header compact-header">
                            <div>
                                <h2>Kvitteringer</h2>
                                <span>{visibleReceipts.length} af {receipts.length} vist</span>
                            </div>
                        </div>
                        <div className="kvitteringer-loading-shell">
                            <div className="kvitteringer-table-scroll">
                                <table className="kvitteringer-table">
                                    <thead>
                                        <tr>
                                            <th>Dato</th>
                                            <th>Butik</th>
                                            <th>Total</th>
                                            <th>Rabat</th>
                                            <th>Uafklaret</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {visibleReceipts.map((receipt) => (
                                            <tr key={receipt.receipt_id} className="kvitteringer-click-row" onClick={() => void handleSelectReceipt(receipt.receipt_id, "kvitteringer")}>
                                                <td>{formatDateTime(receipt.purchase_timestamp)}</td>
                                                <td>{receipt.merchant_name}</td>
                                                <td>{formatMinor(receipt.receipt_total_minor)}</td>
                                                <td>{formatMinor(receipt.attributed_discount_total_minor)}</td>
                                                <td>{formatMinor(receipt.unassigned_discount_total_minor)}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                            {busy ? renderLoadingOverlay("Opdaterer kvitteringer...") : null}
                        </div>
                    </section>

                    {showReceiptSidePanel ? (
                        <section className="panel kvitteringer-panel kvitteringer-receipt-side-panel">
                            {receiptDetailSurface}
                        </section>
                    ) : null}
                </div>
            ) : null}

            {showItemModal ? (
                <div className="modal-backdrop" onClick={() => clearSelectedItemDetail()}>
                    <section className="modal-panel kvitteringers-modal-panel kvitteringer-loading-shell" onClick={(event) => event.stopPropagation()}>
                        {itemDetailSurface}
                    </section>
                </div>
            ) : null}

            {showReceiptModal ? (
                <div className="modal-backdrop" onClick={() => clearSelectedReceiptDetail()}>
                    <section className="modal-panel kvitteringers-modal-panel" onClick={(event) => event.stopPropagation()}>
                        {receiptDetailSurface}
                    </section>
                </div>
            ) : null}

            {showMerchantModal ? (
                <div className="modal-backdrop" onClick={() => clearSelectedMerchantDetail()}>
                    <section className="modal-panel kvitteringers-modal-panel" onClick={(event) => event.stopPropagation()}>
                        {merchantDetailSurface}
                    </section>
                </div>
            ) : null}

            {overviewSunburstState ? (
                <div className="modal-backdrop" onClick={() => clearOverviewSunburst()}>
                    <div
                        className={showOverviewSunburstItemPanel
                            ? "kvitteringer-sunburst-modal-layout kvitteringer-sunburst-modal-layout-split"
                            : "kvitteringer-sunburst-modal-layout"
                        }
                        onClick={(event) => event.stopPropagation()}
                    >
                    <section className="spiir-transactions-modal spiir-sunburst-modal kvitteringer-sunburst-panel">
                        <div className="panel-header compact-header">
                            <div>
                                <p className="eyebrow">Kvitteringer</p>
                                <h2>{overviewSunburstState.title}</h2>
                                <span>{overviewSunburstState.response ? (overviewSunburstSummary ?? "") : "Henter butik/varegruppe/vare-fordeling..."}</span>
                            </div>
                            <div className="kvitteringer-sunburst-header-actions">
                                <div className="scope-switcher" aria-label="Vælg sunburst-lag">
                                    <button
                                        type="button"
                                        className={overviewSunburstView === "merchants" ? "nav-pill active" : "nav-pill"}
                                        onClick={() => setOverviewSunburstView("merchants")}
                                        disabled={!overviewSunburstState.response}
                                    >
                                        Med butikker
                                    </button>
                                    <button
                                        type="button"
                                        className={overviewSunburstView === "categories" ? "nav-pill active" : "nav-pill"}
                                        onClick={() => setOverviewSunburstView("categories")}
                                        disabled={!overviewSunburstState.response}
                                    >
                                        Uden butikker
                                    </button>
                                    <button
                                        type="button"
                                        className={overviewSunburstView === "items" ? "nav-pill active" : "nav-pill"}
                                        onClick={() => setOverviewSunburstView("items")}
                                        disabled={!overviewSunburstState.response}
                                    >
                                        Kun varer
                                    </button>
                                </div>
                                <button type="button" className="secondary-button" onClick={() => clearOverviewSunburst()}>
                                    Luk
                                </button>
                            </div>
                        </div>
                        {overviewSunburstState.response ? (
                            overviewSunburstFigure ? (
                                <Plot
                                    data={overviewSunburstFigure.data as never[]}
                                    layout={overviewSunburstFigure.layout as never}
                                    config={{ displayModeBar: false, responsive: true }}
                                    useResizeHandler
                                    style={{ width: "100%", height: "100%" }}
                                    className="spiir-plot spiir-sunburst-plot kvitteringer-sunburst-plot"
                                    onInitialized={captureOverviewSunburstGraphDiv}
                                    onUpdate={captureOverviewSunburstGraphDiv}
                                />
                            ) : (
                                <div className="kvitteringer-empty-detail">
                                    <h3>Ingen data i perioden</h3>
                                    <p>Ingen positive varelinjer i det valgte udsnit.</p>
                                </div>
                            )
                        ) : (
                            <div className="kvitteringer-loading-shell">
                                {renderLoadingOverlay("Henter sunburst...")}
                            </div>
                        )}
                    </section>
                    {showOverviewSunburstItemPanel ? (
                        <section className="modal-panel kvitteringers-modal-panel kvitteringer-sunburst-detail-panel">
                            {itemDetailSurface}
                        </section>
                    ) : null}
                    </div>
                </div>
            ) : null}
        </section>
    );
}
