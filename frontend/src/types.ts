export interface SpiirOverviewRow {
    key: string;
    label: string;
    level: number;
    parent?: string | null;
    values: Record<string, number>;
    total: number;
    avg: number;
    kind?: string | null;
    categoryType?: string | null;
    mainCategoryName?: string | null;
    mainCategoryId?: string | number | null;
    categoryName?: string | null;
    categoryId?: string | number | null;
    hashtag?: string | null;
}

export interface SpiirOverviewSection {
    periods: string[];
    rows: SpiirOverviewRow[];
}

export interface SpiirUnknownTopEntry {
    desc_key: string;
    amount: number;
}

export interface SpiirSuspectEntry {
    date: string;
    amount: number;
    description: string;
    mainCategoryName: string;
    categoryName: string;
    categoryId?: string | number | null;
    mainCategoryId?: string | number | null;
    yyyymm: string;
}

export interface SpiirOverviewResponse {
    generated_at: string;
    monthly: SpiirOverviewSection;
    yearly: SpiirOverviewSection;
    shopping_extras: {
        unknownTop: SpiirUnknownTopEntry[];
        suspects: SpiirSuspectEntry[];
    };
}

export interface SpiirTransaction {
    yyyymm: string;
    year: string;
    ymd: string;
    amount: number;
    categoryType?: string | null;
    mainCategoryName?: string | null;
    categoryName?: string | null;
    categoryId?: string | number | null;
    mainCategoryId?: string | number | null;
    description?: string | null;
    comment?: string | null;
    hashtags: string[];
}

export interface SpiirStatusResponse {
    raw_exists: boolean;
    processed_exists: boolean;
    raw_file: string;
    processed_dir: string;
    update_log_file?: string;
    generated_at?: string | null;
    transaction_count: number;
    rebuild_required: boolean;
    rebuild_marked_at?: string | null;
    rebuild_reason?: string | null;
}

export interface SpiirIncomeExpenseMonth {
    month: string;
    income: number;
    expense: number;
    fixed_expense?: number | null;
    variable_expense?: number | null;
    net: number;
    income_count?: number | null;
    expense_count?: number | null;
    is_current_month: boolean;
    source: string;
}

export interface SpiirIncomeExpensePeriod {
    label: string;
    totals_title: string;
    start_month: string;
    end_month: string;
    months: string[];
}

export interface SpiirIncomeExpenseSeriesResponse {
    generated_at: string;
    source: string;
    source_generated_at?: string | null;
    months: SpiirIncomeExpenseMonth[];
    years: number[];
    periods: SpiirIncomeExpensePeriod[];
}

export interface NordeaTransaction {
    id: string;
    entry_reference: string;
    booking_date: string;
    transaction_date?: string | null;
    value_date?: string | null;
    amount: number;
    currency: string;
    description: string;
    remittance_information?: string | null;
    creditor_name?: string | null;
    debtor_name?: string | null;
    bank_transaction_code?: string | null;
    merchant_category_code?: string | null;
    status?: string | null;
    credit_debit_indicator?: string | null;
    account_iban?: string | null;
    account_name?: string | null;
    categoryType?: string | null;
    mainCategoryId?: string | number | null;
    mainCategoryName?: string | null;
    categoryId?: string | number | null;
    categoryName?: string | null;
    note?: string | null;
    hashtags: string[];
    is_extraordinary: boolean;
    pending_review?: boolean;
    original_booking_date?: string | null;
    custom_booking_date?: string | null;
    splits: NordeaSplitLine[];
    split_group_id?: string | null;
    split_line_id?: string | null;
    split_original_parent_id?: string | null;
    split_line_index?: number | null;
    source: string;
}

export interface NordeaCategoryOption {
    categoryType: string;
    mainCategoryId?: string | number | null;
    mainCategoryName: string;
    categoryId: string | number;
    categoryName: string;
    usage_count: number;
    search_aliases?: string[];
}

export interface NordeaHashtagOption {
    name: string;
    usage_count: number;
    last_seen: string;
}

export interface NordeaTaxonomyResponse {
    categories: NordeaCategoryOption[];
    hashtags: NordeaHashtagOption[];
}

export interface NordeaSplitLine {
    id: string;
    amount: number;
    note: string;
    category: NordeaCategoryOption;
}

export interface NordeaOverridePatch {
    category?: NordeaCategoryOption | null;
    booking_date?: string | null;
    note?: string;
    hashtags?: string[];
    append_hashtags?: string[];
    remove_hashtags?: string[];
    is_extraordinary?: boolean;
    pending_review?: boolean;
    splits?: NordeaSplitLine[];
}

export interface NordeaTransactionsResponse {
    generated_at?: string | null;
    last_retrieved_at?: string | null;
    last_retrieve_duration_seconds?: number | null;
    transaction_count: number;
    pending_review_count?: number;
    loaded_count?: number;
    offset?: number;
    limit?: number | null;
    has_more?: boolean;
    accounts: unknown[];
    transactions: NordeaTransaction[];
}

export interface NordeaRetrieveResponse {
    retrieved_count: number;
    transaction_count: number;
    raw_files: string[];
    last_retrieved_at?: string | null;
    last_retrieve_duration_seconds?: number | null;
    fetch_window?: Record<string, unknown>;
}

export interface NordeaRetrieveEvent {
    at: string;
    label: string;
    progress: number;
    duration_seconds?: number;
    [key: string]: unknown;
}

export interface NordeaRetrieveJobStatus {
    job_id?: string | null;
    status: "idle" | "queued" | "running" | "succeeded" | "failed";
    started_at?: string | null;
    updated_at?: string | null;
    completed_at?: string | null;
    progress: number;
    current_phase?: string | null;
    events: NordeaRetrieveEvent[];
    result?: NordeaRetrieveResponse | null;
    sync_result?: {
        created_count: number;
        updated_count: number;
        autocategorized_count: number;
        skipped_before_cutover_count: number;
        skipped_missing_booking_date_count: number;
        ledger_row_count: number;
    } | null;
    error?: string | null;
}

export interface NordeaOverrideResponse {
    updated_count: number;
    updated_at: string;
    updated_transactions?: NordeaTransaction[];
    deleted_transaction_ids?: string[];
}

export interface KvitteringerImportRun {
    id: number;
    started_at: string;
    completed_at?: string | null;
    source_path: string;
    status: string;
    source_file_count: number;
    deduplicated_receipt_count: number;
}

export interface KvitteringerStatusResponse {
    source_dir: string;
    database_path: string;
    database_exists: boolean;
    source_file_count: number;
    receipt_count: number;
    merchant_count: number;
    item_cluster_count: number;
    last_import_run?: KvitteringerImportRun | null;
}

export interface KvitteringerImportResponse {
    import_run_id: number;
    source_path: string;
    source_file_count: number;
    raw_receipt_count: number;
    deduplicated_receipt_count: number;
    duplicate_receipt_count: number;
    merchant_count: number;
    item_cluster_count: number;
    validated_receipt_count?: number | null;
    uploaded_original_filename?: string | null;
    uploaded_source_file?: string | null;
    replaced_source_files?: string[];
}

export interface KvitteringerPeriodSummary {
    period: string;
    receipt_count: number;
    total_spend_minor: number;
    average_receipt_minor: number;
    attributed_discount_minor: number;
    unassigned_discount_minor: number;
    gap_receipt_count: number;
    gap_minor: number;
}

export interface KvitteringerOverviewTotals {
    receipt_count: number;
    total_spend_minor: number;
    attributed_discount_minor: number;
    unassigned_discount_minor: number;
    gap_minor: number;
    values: Record<string, number>;
}

export interface KvitteringerOverviewMerchantRow {
    merchant_key: string;
    display_name: string;
    receipt_count: number;
    total_spend_minor: number;
    values: Record<string, number>;
}

export interface KvitteringerOverviewItemRow {
    cluster_id: string;
    preferred_display_name: string;
    category_key: string;
    category_label: string;
    receipt_count: number;
    quantity_total: number;
    total_spend_minor: number;
    values: Record<string, number>;
}

export interface KvitteringerOverviewResponse {
    granularity: "month" | "year";
    periods: string[];
    period_summaries: KvitteringerPeriodSummary[];
    totals: KvitteringerOverviewTotals;
    merchants: KvitteringerOverviewMerchantRow[];
    items: KvitteringerOverviewItemRow[];
}

export interface KvitteringerOverviewSunburstNode {
    id: string;
    parent_id: string;
    kind: "root" | "merchant" | "category" | "item";
    label: string;
    value_minor: number;
    merchant_key?: string | null;
    category_key?: string | null;
    cluster_id?: string | null;
}

export interface KvitteringerOverviewSunburstResponse {
    granularity: "month" | "year";
    periods: string[];
    positive_net_spend_minor: number;
    receipt_total_minor: number;
    unassigned_discount_minor: number;
    excluded_negative_net_spend_minor: number;
    nodes: KvitteringerOverviewSunburstNode[];
}

export interface KvitteringerReceiptSummary {
    receipt_id: string;
    merchant_key: string;
    merchant_name: string;
    purchase_timestamp: string;
    purchase_date: string;
    currency: string;
    receipt_total_minor: number;
    parsed_item_total_minor: number;
    attributed_discount_total_minor: number;
    unassigned_discount_total_minor: number;
    gap_minor: number;
    has_ambiguous_discount_block: boolean;
}

export interface KvitteringerReceiptLine {
    line_index: number;
    line_number_raw?: number | null;
    product_number_raw?: string | null;
    name_raw?: string | null;
    name_normalized: string;
    count_raw?: number | null;
    item_price_minor?: number | null;
    total_price_minor?: number | null;
    is_discount_line: boolean;
    is_negative_non_discount_line: boolean;
}

export interface KvitteringerOccurrence {
    occurrence_id: string;
    receipt_id: string;
    merchant_key: string;
    merchant_name?: string | null;
    purchase_timestamp: string;
    purchase_date: string;
    source_line_index: number;
    product_number?: string | null;
    display_name: string;
    normalized_name: string;
    variant_signature: string;
    item_key: string;
    cluster_id: string;
    quantity: number;
    gross_total_minor: number;
    discount_minor: number;
    net_total_minor: number;
    unit_price_minor?: number | null;
    is_return: boolean;
    is_refund: boolean;
    category_key?: string | null;
}

export interface KvitteringerDiscount {
    receipt_id: string;
    line_index: number;
    amount_minor: number;
    attribution_status: string;
    attributed_occurrence_id?: string | null;
    reason: string;
}

export interface KvitteringerReceiptDetail {
    receipt: KvitteringerReceiptSummary;
    lines: KvitteringerReceiptLine[];
    occurrences: KvitteringerOccurrence[];
    discounts: KvitteringerDiscount[];
}

export interface KvitteringerMerchantSummary {
    merchant_key: string;
    display_name: string;
    receipt_count: number;
    spend_minor: number;
    average_basket_minor: number;
    attributed_discount_minor: number;
    unassigned_discount_minor: number;
    item_diversity: number;
}

export interface KvitteringerItemClusterSummary {
    cluster_id: string;
    preferred_display_name: string;
    product_number?: string | null;
    normalized_name: string;
    variant_signature: string;
    collapse_strategy: string;
    confidence: string;
    category_key: string;
    category_label: string;
    category_source: string;
    category_confidence: string;
    category_is_override: boolean;
    receipt_count: number;
    quantity_total: number;
    gross_spend_minor: number;
    net_spend_minor: number;
    total_discount_minor: number;
    avg_unit_price_minor: number;
    min_unit_price_minor?: number | null;
    max_unit_price_minor?: number | null;
    first_purchase_date?: string | null;
    last_purchase_date?: string | null;
}

export interface KvitteringerItemAlias {
    raw_name: string;
    normalized_name: string;
    variant_signature: string;
    product_number?: string | null;
    first_seen_receipt_id?: string | null;
    last_seen_receipt_id?: string | null;
}

export interface KvitteringerCategoryOption {
    key: string;
    label: string;
}

export interface KvitteringerItemClusterDetail {
    cluster: KvitteringerItemClusterSummary;
    aliases: KvitteringerItemAlias[];
    category_options: KvitteringerCategoryOption[];
}
