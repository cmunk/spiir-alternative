export function parseSplitDraftAmount(value: string): number {
    const normalized = value.trim().replace(/\s/g, "").replace(",", ".");
    if (!normalized || normalized === "+" || normalized === "-" || normalized === "." || normalized === "+." || normalized === "-.") {
        return Number.NaN;
    }
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) {
        return Number.NaN;
    }
    return Number(normalized);
}

export function formatSplitDraftAmount(value: number): string {
    if (!Number.isFinite(value)) {
        return "";
    }
    return String(Math.round(value * 100) / 100).replace(".", ",");
}