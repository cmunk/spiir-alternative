import { type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";

import { getNordeaRetrieveStatus, getNordeaTaxonomy, getNordeaTransactions, getSpiirIncomeExpenseSeries, getSpiirLocalLedgerTransactions, getSpiirLocalLedgerTransactionsPage, getSpiirOverview, getSpiirStatus, getSpiirTransactions, invalidateLocalLedgerCache, invalidateSpiirCache, rebuildSpiirFromLocal, saveNordeaOverrides, saveSpiirLocalLedgerOverrides, scheduleSpiirRebuildFromLocal, startNordeaRetrieveJob, syncNordeaIntoSpiirLocalLedger } from "./api";
import { computeAllTransactionsLoaded, localLedgerFirstPage, mergeUpdatedTransactions } from "./nordeaState";
import SpiirSunburstModal, { type SunburstState } from "./SpiirSunburstModal";
import { formatSplitDraftAmount, parseSplitDraftAmount } from "./splitAmount";
import type { NordeaCategoryOption, NordeaHashtagOption, NordeaOverridePatch, NordeaRetrieveJobStatus, NordeaSplitLine, NordeaTaxonomyResponse, NordeaTransaction, NordeaTransactionsResponse, SpiirIncomeExpenseMonth, SpiirIncomeExpenseSeriesResponse, SpiirOverviewResponse, SpiirStatusResponse, SpiirTransaction } from "./types";

type PeriodFilter = "all" | "custom" | `year:${string}` | `month:${string}`;
type VisibilityFilter = "all" | "income" | "expense" | "bills" | "consumption" | "category" | "uncategorized" | "extraordinary";
type SortKey = "booking_date" | "description" | "category" | "amount";
type SortDirection = "asc" | "desc";

export type NordeaDrilldownFilter = {
    title: string;
    periodFilter?: PeriodFilter;
    periodStart?: string;
    periodEnd?: string;
    visibilityFilter?: VisibilityFilter;
    categoryFilter?: NordeaCategoryOption | null;
    searchText?: string;
};
type SplitDraftLine = {
    id: string;
    amount: number;
    amountText: string;
    note: string;
    category: NordeaCategoryOption | null;
    locked: boolean;
};

type NordeaDisplayRow = {
    rowId: string;
    parentId: string;
    transaction: NordeaTransaction;
    splitId: string | null;
    splitIndex: number | null;
    isSplitChild: boolean;
    amount: number;
    note: string;
    category: NordeaCategoryOption;
};

const HASHTAG_TOKEN_RE = /(?<![0-9A-Za-z_æøåÆØÅ-])#([0-9A-Za-z_æøåÆØÅ-]+)/gi;

const PAGE_SIZE = 200;
const LOCAL_LEDGER_INITIAL_LIMIT = 300;
const MOBILE_LAYOUT_MEDIA_QUERY = "(max-width: 760px)";
const MOBILE_RENDER_INITIAL_LIMIT = 50;
const MOBILE_RENDER_INCREMENT = 100;
const SPIIR_MAIN_CATEGORY_ORDER = [
    "Bolig",
    "Transport",
    "Husholdning",
    "Andre leveomkostninger",
    "Privatforbrug",
    "Ferie",
    "Diverse",
    "Lån & gæld",
    "Pension & Opsparing",
    "Indkomst",
    "Vis ikke",
    "Ikke kategoriseret",
];
const SPIIR_SUBCATEGORY_ORDER: Record<string, string[]> = {
    Bolig: ["Boliglån/husleje", "El, vand, varme & renovation", "Ejerforening", "Ejendomsskat", "Husforsikring", "Indbo- & familieforsikring", "Alarmsystem", "Udgifter fritidshus", "Ombygning & vedligehold", "Have & planter", "Andre boligudgifter"],
    Transport: ["Bil-, MC-, bådlån o.l.", "Brændstof", "Bilforsikring & autohjælp", "Ejerafgift/grøn afgift", "Bus, tog, færge o.l.", "Taxi", "Parkering", "Værksted & reservedele", "Anden transport"],
    Husholdning: ["Dagligvarer", "Kiosk, bager & specialbutikker", "Kantine- & frokostordning"],
    "Andre leveomkostninger": ["Apotek & medicin", "Behandling & læger", "Underholds- & børnebidrag", "Institution", "Fagforening & a-kasse", "Livs- & ulykkesforsikring", "Sundheds- & sygeforsikring", "Briller & kontaktlinser", "TV & streaming", "Telefoni & internet", "Studieudgifter", "Foreninger & kontingenter"],
    Privatforbrug: ["Fastfood & takeaway", "Bar, cafe & restaurant", "Tøj, sko & accessories", "Møbler & boligudstyr", "Elektronik & computerudstyr", "Film, musik & læsestof", "Online services & software", "Hobby & sportsudstyr", "Biograf, koncerter & forlystelser", "Frisør & personlig pleje", "Sport & fritid", "Hus & havehjælp", "Spil & legetøj", "Tips & lotto", "Babyudstyr", "Kæledyr", "Gaver & velgørenhed", "Tobak & alkohol", "Kontanthævning & check", "Højskole- & kursusophold", "Serviceydelser & rådgivning", "Andet privatforbrug"],
    Ferie: ["Fly & Hotel", "Billeje", "Sommerhus & camping", "Ferieaktiviteter", "Rejseforsikring"],
    Diverse: ["Ukendt", "Bankgebyrer", "Rykkergebyrer", "Bøder & afgifter", "Restskat", "Offentligt gebyr", "Ikke kategoriseret"],
    "Lån & gæld": ["Studielån", "Forbrugslån", "Private lån (venner & familie)", "Udlånsrenter"],
    "Pension & Opsparing": ["Pensionsopsparing", "Børneopsparing", "Anden opsparing", "Værdipapirshandel"],
    Indkomst: ["Løn", "Pensionsudbetaling", "Dagpenge/overførselsindkomst", "SU & studielån", "Børnepenge", "Underholds- & børnebidrag", "Feriepenge", "Renteindtægter", "Udbytte & afkast", "Overskydende skat", "Boligstøtte", "Anden indkomst"],
    "Vis ikke": ["Kontooverførsel", "Udlæg", "Ignorer"],
};
const SPIIR_FIXED_CATEGORY_NAMES = new Set([
    "Boliglån/husleje", "El, vand, varme & renovation", "Ejerforening", "Ejendomsskat", "Husforsikring", "Indbo- & familieforsikring", "Alarmsystem", "Udgifter fritidshus",
    "Bil-, MC-, bådlån o.l.", "Bilforsikring & autohjælp", "Ejerafgift/grøn afgift",
    "Underholds- & børnebidrag", "Institution", "Fagforening & a-kasse", "Livs- & ulykkesforsikring", "Sundheds- & sygeforsikring", "TV & streaming", "Telefoni & internet", "Foreninger & kontingenter",
    "Studielån", "Forbrugslån", "Private lån (venner & familie)", "Pensionsopsparing", "Børneopsparing", "Anden opsparing",
]);
const SPIIR_CATEGORY_ALIASES: Record<string, string[]> = {
    "Boliglån/husleje": ["Pantebreve", "Realkreditlån", "Rent"],
    "El, vand, varme & renovation": ["Gas", "Oliefyr", "Naturgas", "Fjernvarme", "Affald", "Skrald"],
    Ejerforening: ["Grundejerforening", "Parcelforening"],
    Ejendomsskat: ["Grundskyld"],
    Husforsikring: ["Villaforsikring"],
    "Indbo- & familieforsikring": ["Basisforsikring"],
    "Udgifter fritidshus": ["Udgifter sommerhus", "Udgifter campingvogn"],
    "Ombygning & vedligehold": ["Udbygning", "Maler", "VVS", "Tømrer", "Murer", "Elektriker", "Nyt køkken", "Reparation", "Arkitekt"],
    "Have & planter": ["Blomster", "Potter"],
    "Andre boligudgifter": ["Flytning", "Advokat", "Ejendomsmægler", "Ejerskifteforsikring", "Depositum", "Møntvaskeri", "Vaskeri", "Tøjvask"],
    "Bil-, MC-, bådlån o.l.": ["Billån", "Motorcykellån"],
    Brændstof: ["Benzin", "Diesel", "Tankstation"],
    "Bilforsikring & autohjælp": ["Falck", "FDM", "Vejhjælp"],
    "Ejerafgift/grøn afgift": ["Vægtafgift", "Bilafgift"],
    "Bus, tog, færge o.l.": ["Brobizz", "Metro", "S-tog", "Arriva", "DSB", "Broafgift", "Månedskort", "Togkort", "Buskort", "Vejafgift", "Pendlerkort", "Periodekort", "Rejsekort", "Klippekort"],
    Taxi: ["Taxa", "Hyrevogn", "Uber"],
    Parkering: ["Parkpark", "easypark", "QPark"],
    "Værksted & reservedele": ["Syn", "Service", "Reparation", "Vinterdæk", "Fælge", "Bilreparation", "Bilvask"],
    "Anden transport": ["Ny bil", "Ny motorcykel", "Ny båd", "Ny cykel", "Ny MC", "Gomore", "Cykel", "El-løbehjul"],
    Dagligvarer: ["Mad", "Supermarked", "Madvarer"],
    "Kiosk, bager & specialbutikker": ["Brød", "Kager", "Frugt", "Købmand", "Slik", "Tankstation"],
    "Kantine- & frokostordning": ["Madordning", "Skolemad"],
    "Apotek & medicin": ["Creme", "Personlig pleje", "Astma"],
    "Behandling & læger": ["Tandlæge", "Øjenlæge", "Speciallæge", "Kiropraktor", "Fysioterapeut", "Psykolog", "Hypnotisør", "Akupunktør", "Zoneterapeut"],
    Institution: ["Madordning", "Klassekasse", "Børnehave", "Vuggestue", "SFO", "Fritidshjem", "Dagpleje", "Efterskole", "Privatskole", "Daginstitution"],
    "Fagforening & a-kasse": ["Fagligt kontingent", "Akasse", "HK", "3F", "Prosa"],
    "Livs- & ulykkesforsikring": ["Gruppeliv"],
    "Sundheds- & sygeforsikring": ["Forebygger"],
    "Briller & kontaktlinser": ["Optiker"],
    "TV & streaming": ["Kabel TV", "Viasat", "Sattelit", "Antenneforening", "Radio", "Netflix", "HBO", "Viaplay"],
    "Telefoni & internet": ["Mobiltelefon", "Taletidskort", "Udlandstelefoni", "Fastnet", "Fiber", "ADSL", "Bredbånd"],
    Studieudgifter: ["Studiebøger", "Kopier", "Faglitteratur", "Fagbøger"],
    "Foreninger & kontingenter": ["Medlemsskab"],
    "Fastfood & takeaway": ["Junkfood", "Burger", "Sushi", "Pizzaria", "Takeaway", "Indisk"],
    "Bar, cafe & restaurant": ["Diskotek", "Værtshus", "Disco", "Fest", "Middag"],
    "Tøj, sko & accessories": ["Smykker", "Bukser", "Bluse", "Jeans", "Kjole", "Taske", "Jakke", "Frakke", "Støvler", "Ring", "Halskæde", "T-shirt", "Skjorte", "Beklædning"],
    "Møbler & boligudstyr": ["Køkkenudstyr", "Sofa", "Seng", "Bord", "Stole", "Hvidevarer", "Lamper", "Malerier", "Kunst", "Inventar"],
    "Elektronik & computerudstyr": ["Ny mobiltelefon", "Playstation", "Wii", "XBOX", "Konsol", "Reparation", "PC", "Nintendo"],
    "Film, musik & læsestof": ["Bøger", "Blade", "Aviser", "Magasiner", "DVD", "CD", "MP3", "Itunes", "Dameblade", "Faglitteratur", "Fagbøger", "Skønlitteratur", "Spotify"],
    "Online services & software": ["Webhotel", "Itunes", "Domæne", "Apps"],
    "Hobby & sportsudstyr": ["Skitøj", "Golfudstyr", "Surfudstyr", "Løbesko", "Løbetøj", "Pulsmåler"],
    "Biograf, koncerter & forlystelser": ["Museum", "Kultur", "Biffen", "Musik", "Billetter", "Tivoli", "Sommerland", "Legeland"],
    "Frisør & personlig pleje": ["Parfume", "Klipning", "Hårklip", "Creme", "Massage", "Coaching", "Wellness", "Solcenter"],
    "Sport & fritid": ["Spejder", "Fitness", "Styrketræning", "Aftenskole", "Håndbold", "Fodbold", "Basket", "Badminton", "Tennis", "Svømning", "Squash", "Golf"],
    "Hus & havehjælp": ["Rengøring", "Gartner", "Vinduespudser"],
    "Spil & legetøj": ["Playstation spil", "XBOX spil", "Wii spil", "PC spil"],
    "Tips & lotto": ["Poker", "Klasselotteri", "Casino", "Odds", "Kasino", "Lotteri", "Banko", "Bingo"],
    Babyudstyr: ["Barnevogn", "Klapvogn", "Barneseng"],
    Kæledyr: ["Hund", "Kat", "Edderkop"],
    "Gaver & velgørenhed": ["Nødhjælp", "Blomster", "Donationer", "Røde Kors", "Red Barnet", "Folkekirkens Nødhjælp", "WWF Verdensnaturfonden", "WSPA", "Børnefonde", "Læger uden grænser", "Amnesty International", "Unicef", "Gave"],
    "Tobak & alkohol": ["Spiritus", "Cigaretter", "Øl", "Vin", "Snus", "Vape"],
    "Kontanthævning & check": ["Hæveautomat"],
    "Serviceydelser & rådgivning": ["Revisor", "Advokat", "Privatøkonomisk rådgiver", "Coaching"],
    "Andet privatforbrug": ["Barnepige", "Frimærker", "Babysitter", "Fragt", "Posthus", "Pakker", "Lommepenge", "Kontorartikler", "Tøjrens", "Renseri", "Kreditkort"],
    "Fly & Hotel": ["Charterferie", "Rejser"],
    Billeje: ["Hertz", "Avis"],
    Ferieaktiviteter: ["Skileje", "Liftkort", "Skiskole", "Tivoli"],
    Ukendt: ["Ved ikke"],
    "Bøder & afgifter": ["fartbøde", "parkeringsbøde"],
    "Offentligt gebyr": ["Pas", "Kørekort", "Kommune", "told"],
    Pensionsopsparing: ["Ratepension", "Kapitalpension"],
    "Anden opsparing": ["Ferieopsparing"],
    Værdipapirshandel: ["Investering", "Aktier"],
    Pensionsudbetaling: ["Tjenestemandspension", "Førtidspension"],
    "Dagpenge/overførselsindkomst": ["Kontanthjælp"],
    Børnepenge: ["Familieydelse", "Børnecheck"],
    "Udbytte & afkast": ["Bonus"],
    Boligstøtte: ["Boligsikring", "Boligtilskud"],
    "Anden indkomst": ["Arveforskud", "Pengegaver"],
};

function formatDateTime(value: string | null | undefined): string {
    if (!value) {
        return "-";
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
        return value;
    }
    return new Intl.DateTimeFormat("da-DK", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit"
    }).format(parsed);
}

function categoryOrderIndex(value: string, order: string[]): number {
    const index = order.indexOf(value);
    return index === -1 ? order.length : index;
}

function spiirMainName(value: string): string {
    return value === "Andet" ? "Andre leveomkostninger" : value;
}

function spiirMenuMainName(category: NordeaCategoryOption): string {
    return category.categoryName === "Ikke kategoriseret" ? "Ikke kategoriseret" : spiirMainName(category.mainCategoryName || "Diverse");
}

function spiirSearchRank(value: string, query: string): number {
    const normalizedValue = value.toLowerCase();
    const normalizedQuery = query.toLowerCase();
    const index = normalizedValue.indexOf(normalizedQuery);
    if (index === 0) {
        return 3;
    }
    if (new RegExp(`(^|\\s)${normalizedQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(normalizedValue)) {
        return 2;
    }
    return index > 0 ? 1 : 0;
}

function formatTxDate(value: string): string {
    if (!value) {
        return "-";
    }
    const [year, month, day] = value.split("-");
    if (!year || !month || !day) {
        return value;
    }
    return `${day}-${month}-${year}`;
}

function formatMobileTxDate(value: string): string {
    if (!value) {
        return "-";
    }
    const [year, month, day] = value.split("-");
    const parsed = new Date(Number(year), Number(month) - 1, Number(day));
    if (Number.isNaN(parsed.getTime())) {
        return formatTxDate(value);
    }
    return new Intl.DateTimeFormat("da-DK", {
        day: "numeric",
        month: "short",
        year: "numeric",
    }).format(parsed).replace(/\.$/, "");
}

function formatMobileAmount(value: number): string {
    const formatted = formatPostingAmount(value);
    return value > 0 ? `+${formatted}` : formatted;
}

function formatPostingAmount(value: number): string {
    return new Intl.NumberFormat("da-DK", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    }).format(value);
}

function formatSidebarAmount(value: number): string {
    return `${new Intl.NumberFormat("da-DK", {
        maximumFractionDigits: 0,
        minimumFractionDigits: 0
    }).format(value)} kr`;
}

function formatWholeDkk(value: number): string {
    return `${new Intl.NumberFormat("da-DK", {
        maximumFractionDigits: 0,
        minimumFractionDigits: 0
    }).format(value)} kr`;
}

function formatChartAmount(value: number): string {
    return new Intl.NumberFormat("da-DK", {
        maximumFractionDigits: 0,
        minimumFractionDigits: 0
    }).format(value);
}

function formatDkk(value: number): string {
    return new Intl.NumberFormat("da-DK", {
        style: "currency",
        currency: "DKK",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    }).format(value);
}

function counterparty(transaction: NordeaTransaction): string {
    return transaction.creditor_name || transaction.debtor_name || transaction.bank_transaction_code || "-";
}

function monthLabel(value: string): string {
    const [year, month] = value.split("-");
    const parsed = new Date(Number(year), Number(month) - 1, 1);
    if (Number.isNaN(parsed.getTime())) {
        return value;
    }
    return new Intl.DateTimeFormat("da-DK", { month: "long", year: "numeric" }).format(parsed);
}

function shortMonthLabel(value: string): string {
    const [year, month] = value.split("-");
    const parsed = new Date(Number(year), Number(month) - 1, 1);
    if (Number.isNaN(parsed.getTime())) {
        return value;
    }
    return new Intl.DateTimeFormat("da-DK", { month: "short" }).format(parsed).replace(".", "");
}

function longMonthLabel(value: string): string {
    const [year, month] = value.split("-");
    const parsed = new Date(Number(year), Number(month) - 1, 1);
    if (Number.isNaN(parsed.getTime())) {
        return value;
    }
    return new Intl.DateTimeFormat("da-DK", { month: "long", year: "numeric" }).format(parsed);
}

function transactionText(transaction: NordeaTransaction): string {
    return [
        transaction.description,
        transaction.remittance_information,
        transaction.creditor_name,
        transaction.debtor_name,
        transaction.bank_transaction_code,
        transaction.entry_reference
    ].filter(Boolean).join(" ");
}

function detailTitle(transaction: NordeaTransaction): string {
    return [
        transaction.remittance_information,
        transaction.bank_transaction_code,
        transaction.creditor_name,
        transaction.debtor_name,
        transaction.entry_reference ? `Ref: ${transaction.entry_reference}` : null
    ].filter(Boolean).join("\n");
}

function descriptionLabel(transaction: NordeaTransaction): string {
    const note = transaction.note?.trim();
    return note ? `${transaction.description} (${note})` : transaction.description;
}

function normalizeHashtag(value: string): string {
    return value.trim().replace(/^#+/, "").toLowerCase();
}

function extractedHashtags(value: string): string[] {
    const seen = new Set<string>();
    const tags: string[] = [];
    for (const match of value.matchAll(HASHTAG_TOKEN_RE)) {
        const tag = normalizeHashtag(match[1] ?? "");
        if (tag && !seen.has(tag)) {
            seen.add(tag);
            tags.push(tag);
        }
    }
    return tags;
}

function noteWithHashtags(note: string, hashtags: string[] | null | undefined): string {
    const existing = new Set(extractedHashtags(note));
    const missing = (hashtags ?? [])
        .map(normalizeHashtag)
        .filter((tag, index, tags) => tag && !existing.has(tag) && tags.indexOf(tag) === index);
    return missing.length === 0 ? note : `${note.trim()} ${missing.map((tag) => `#${tag}`).join(" ")}`.trim();
}

function noteWithoutHashtags(note: string, hashtags: string[]): string {
    const removed = new Set(hashtags.map(normalizeHashtag).filter(Boolean));
    if (removed.size === 0) {
        return note;
    }
    return note.replace(HASHTAG_TOKEN_RE, (token, tag) => removed.has(normalizeHashtag(tag ?? "")) ? "" : token).replace(/\s{2,}/g, " ").trim();
}

function activeHashtagToken(value: string, caret: number | null): { start: number; prefix: string } | null {
    if (caret === null) {
        return null;
    }
    const beforeCaret = value.slice(0, caret);
    const match = beforeCaret.match(/(^|\s)#([A-Za-zÀ-ÿ0-9_'.+-]*)$/);
    if (!match) {
        return null;
    }
    const token = match[2] ?? "";
    if (token.length > 20) {
        return null;
    }
    return { start: beforeCaret.length - token.length - 1, prefix: token };
}

function matchingHashtagSuggestions(hashtags: NordeaHashtagOption[], prefix: string): NordeaHashtagOption[] {
    if (!prefix) {
        return hashtags.slice(0, 5);
    }
    const query = prefix.toLowerCase();
    return hashtags
        .map((hashtag, index) => ({ hashtag, index, order: hashtag.name.toLowerCase().indexOf(query) }))
        .filter((item) => item.order > -1)
        .sort((left, right) => left.order - right.order || left.index - right.index)
        .slice(0, 5)
        .map((item) => item.hashtag);
}

function highlightedHashtagName(name: string, prefix: string): (string | JSX.Element)[] {
    if (!prefix) {
        return [name];
    }
    const index = name.toLowerCase().indexOf(prefix.toLowerCase());
    if (index < 0) {
        return [name];
    }
    return [
        name.slice(0, index),
        <strong key="match">{name.slice(index, index + prefix.length)}</strong>,
        name.slice(index + prefix.length),
    ];
}

function similarWords(transaction: NordeaTransaction): string[] {
    return transaction.description
        .split(/\s+/)
        .map((word) => word.replace(/[(),.;:]/g, "").trim())
        .filter((word) => word.length > 2 && !/^\d+$/.test(word))
        .slice(0, 5);
}

function categoryKey(category: Pick<NordeaCategoryOption, "mainCategoryId" | "categoryId"> | null | undefined): string {
    if (!category?.categoryId) {
        return "";
    }
    return `${String(category.mainCategoryId ?? "")}|${String(category.categoryId)}`;
}

function buildMainCategoryOption(mainCategoryId: string | number | null | undefined, mainCategoryName: string, categoryType = "Expense", usageCount = 0): NordeaCategoryOption {
    return {
        mainCategoryId: mainCategoryId ?? "",
        mainCategoryName,
        categoryId: `__main__::${String(mainCategoryId ?? "")}`,
        categoryName: mainCategoryName,
        categoryType,
        usage_count: usageCount,
    };
}

function categoryFromTransaction(transaction: NordeaTransaction): NordeaCategoryOption {
    return {
        mainCategoryId: transaction.mainCategoryId ?? "synthetic-diverse",
        mainCategoryName: transaction.mainCategoryName || "Diverse",
        categoryId: transaction.categoryId ?? "synthetic-uncategorized",
        categoryName: transaction.categoryName || "Ikke kategoriseret",
        categoryType: transaction.categoryType || "uncategorized",
        usage_count: 0
    };
}

function categoryLabel(transaction: NordeaTransaction): string {
    return transaction.categoryName || "Ikke kategoriseret";
}

function categoryLabelForRow(row: NordeaDisplayRow): string {
    return row.category.categoryName || "Ikke kategoriseret";
}

function categoryMainId(value: Pick<NordeaCategoryOption, "mainCategoryId">): string {
    return String(value.mainCategoryId ?? "");
}

function categorySubId(value: Pick<NordeaCategoryOption, "categoryId">): string {
    return String(value.categoryId ?? "");
}

function categoryMainFilterValue(mainCategoryId: string): string {
    return `main::${mainCategoryId}`;
}

function categorySubFilterValue(mainCategoryId: string, categoryId: string): string {
    return `sub::${mainCategoryId}::${categoryId}`;
}

function categoryFilterMatches(rowCategory: NordeaCategoryOption, selectedCategory: NordeaCategoryOption | null): boolean {
    if (!selectedCategory) {
        return false;
    }
    const selectedCategoryId = categorySubId(selectedCategory);
    if (selectedCategoryId.startsWith("__main__::")) {
        return categoryMainId(rowCategory) === categoryMainId(selectedCategory);
    }
    if (!categoryMainId(selectedCategory)) {
        return categorySubId(rowCategory) === selectedCategoryId
            && (!selectedCategory.mainCategoryName || rowCategory.mainCategoryName === selectedCategory.mainCategoryName);
    }
    return categoryMainId(rowCategory) === categoryMainId(selectedCategory)
        && categorySubId(rowCategory) === selectedCategoryId;
}

function visibilityLabel(filter: VisibilityFilter, categoryLabel: string): string {
    if (filter === "all") {
        return "Alle poster";
    }
    if (filter === "bills") {
        return "Alle regninger";
    }
    if (filter === "income") {
        return "Indkomst";
    }
    if (filter === "expense") {
        return "Expense";
    }
    if (filter === "consumption") {
        return "Alt forbrug";
    }
    if (filter === "category") {
        return categoryLabel || "Vælg kategori";
    }
    if (filter === "uncategorized") {
        return "Ikke kategoriserede poster";
    }
    return "Ekstraordinære poster";
}

function isTransferCategory(category: NordeaCategoryOption): boolean {
    return spiirMenuMainName(category) === "Vis ikke";
}

function nordeaRowClassName(row: NordeaDisplayRow, selected: boolean, selectedCount: number): string | undefined {
    const classes = [];
    if (selected) {
        classes.push("nordea-selected-row");
        if (selectedCount === 1) {
            classes.push("nordea-editor-row");
        }
    } else if (isPendingReview(row.transaction)) {
        classes.push("nordea-pending-row");
    } else if (row.transaction.is_extraordinary) {
        classes.push("nordea-extraordinary-row");
    }
    if (isTransferCategory(row.category)) {
        classes.push("nordea-transfer-row");
    }
    return classes.length > 0 ? classes.join(" ") : undefined;
}

function descriptionLabelForRow(row: NordeaDisplayRow): string {
    const note = row.note.trim();
    return note ? `${row.transaction.description} (${note})` : row.transaction.description;
}

function transactionTextForRow(row: NordeaDisplayRow): string {
    const hashtags = (row.transaction.hashtags ?? []).flatMap((tag) => {
        const normalizedTag = normalizeHashtag(tag);
        return normalizedTag ? [normalizedTag, `#${normalizedTag}`] : [];
    });
    return [
        transactionText(row.transaction),
        row.note,
        ...hashtags,
        categoryLabelForRow(row)
    ].filter(Boolean).join(" ");
}

function rowHasHashtag(row: NordeaDisplayRow, hashtag: string): boolean {
    const normalizedTag = normalizeHashtag(hashtag);
    if (!normalizedTag) {
        return false;
    }
    return [
        ...(row.transaction.hashtags ?? []),
        ...extractedHashtags(row.note),
    ].some((tag) => normalizeHashtag(tag) === normalizedTag);
}

function isPendingReview(transaction: NordeaTransaction): boolean {
    return Boolean(transaction.pending_review);
}

function transactionSortValueForRow(row: NordeaDisplayRow, sortKey: SortKey): string | number {
    if (sortKey === "booking_date") {
        return row.transaction.booking_date || "";
    }
    if (sortKey === "description") {
        return descriptionLabelForRow(row);
    }
    if (sortKey === "category") {
        return categoryLabelForRow(row);
    }
    return row.amount;
}

function roundAmount(value: number): number {
    return Math.round(value * 100) / 100;
}

function isUncategorizedCategory(category: NordeaCategoryOption | null | undefined): boolean {
    return !category || category.categoryName === "Ikke kategoriseret";
}

function hasEffectiveSplit(transaction: NordeaTransaction): boolean {
    return (transaction.splits ?? []).length > 1 || Boolean(transaction.split_group_id);
}

function hasEmbeddedSplit(transaction: NordeaTransaction): boolean {
    return (transaction.splits ?? []).length > 1;
}

function splitLineSortKey(transaction: NordeaTransaction): [number, string] {
    return [transaction.split_line_index ?? 999999, transaction.id];
}

function isGatewayTimeoutError(error: unknown): boolean {
    if (!(error instanceof Error)) {
        return false;
    }
    return /\b504\b|gateway\s*time-?out/i.test(error.message);
}

function rowMatchesFilters(
    row: NordeaDisplayRow,
    filters: {
        periodFilter: PeriodFilter;
        periodStart?: string;
        periodEnd?: string;
        visibilityFilter: VisibilityFilter;
        categoryFilter: NordeaCategoryOption | null;
        searchText: string;
        showTransfersAlways: boolean;
    }
): boolean {
    const bookingDate = row.transaction.booking_date || "";
    if (filters.periodFilter === "custom" && filters.periodStart && filters.periodEnd && (bookingDate < filters.periodStart || bookingDate > filters.periodEnd)) {
        return false;
    }
    if (filters.periodFilter.startsWith("year:") && bookingDate.slice(0, 4) !== filters.periodFilter.slice(5)) {
        return false;
    }
    if (filters.periodFilter.startsWith("month:") && bookingDate.slice(0, 7) !== filters.periodFilter.slice(6)) {
        return false;
    }
    const transferOverride = filters.visibilityFilter === "all" && filters.showTransfersAlways && isTransferCategory(row.category);
    if (!transferOverride) {
        if (filters.visibilityFilter === "bills" && !SPIIR_FIXED_CATEGORY_NAMES.has(row.category.categoryName)) {
            return false;
        }
        if (filters.visibilityFilter === "income" && row.category.categoryType !== "Income") {
            return false;
        }
        if (filters.visibilityFilter === "expense" && row.category.categoryType !== "Expense") {
            return false;
        }
        if (filters.visibilityFilter === "consumption" && row.amount >= 0) {
            return false;
        }
        if (filters.visibilityFilter === "uncategorized" && !isUncategorizedCategory(row.category)) {
            return false;
        }
        if (filters.visibilityFilter === "extraordinary" && !row.transaction.is_extraordinary) {
            return false;
        }
        if (filters.visibilityFilter === "category" && !categoryFilterMatches(row.category, filters.categoryFilter)) {
            return false;
        }
    }
    const needle = filters.searchText.trim().toLowerCase();
    return !needle || transactionTextForRow(row).toLowerCase().includes(needle);
}

function categoryOptionFromSpiirTransactions(items: SpiirTransaction[]): NordeaCategoryOption | null {
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

function periodFilterFromSpiirTransactions(items: SpiirTransaction[]): NordeaDrilldownFilter["periodFilter"] {
    const months = [...new Set(items.map((item) => item.yyyymm).filter(Boolean))];
    if (months.length === 1) {
        return `month:${months[0]}`;
    }
    const years = [...new Set(items.map((item) => item.year).filter(Boolean))];
    return years.length === 1 ? `year:${years[0]}` : "all";
}

function buildDisplayRows(transactions: NordeaTransaction[]): NordeaDisplayRow[] {
    const splitChildIds = new Set<string>();
    const canonicalSplitGroups = new Map<string, NordeaTransaction[]>();
    const renderedCanonicalGroups = new Set<string>();
    for (const transaction of transactions) {
        const groupId = transaction.split_group_id?.trim();
        if (groupId) {
            canonicalSplitGroups.set(groupId, [...(canonicalSplitGroups.get(groupId) ?? []), transaction]);
        }
        if ((transaction.splits ?? []).length <= 1) {
            continue;
        }
        for (const split of transaction.splits ?? []) {
            if (split.id) {
                splitChildIds.add(split.id);
            }
        }
    }

    return transactions.flatMap<NordeaDisplayRow>((transaction) => {
        if (splitChildIds.has(transaction.id)) {
            return [];
        }
        const canonicalGroupId = transaction.split_group_id?.trim();
        if (canonicalGroupId) {
            if (renderedCanonicalGroups.has(canonicalGroupId)) {
                return [];
            }
            const groupRows = [...(canonicalSplitGroups.get(canonicalGroupId) ?? [])].sort((left, right) => {
                const [leftIndex, leftId] = splitLineSortKey(left);
                const [rightIndex, rightId] = splitLineSortKey(right);
                return leftIndex === rightIndex ? leftId.localeCompare(rightId) : leftIndex - rightIndex;
            });
            if (groupRows.length > 1) {
                renderedCanonicalGroups.add(canonicalGroupId);
                return groupRows.map((row, index) => ({
                    rowId: row.id,
                    parentId: row.id,
                    transaction: row,
                    splitId: row.split_line_id ?? row.id,
                    splitIndex: row.split_line_index ?? index,
                    isSplitChild: true,
                    amount: row.amount,
                    note: noteWithHashtags(row.note ?? "", row.hashtags),
                    category: categoryFromTransaction(row)
                }));
            }
        }
        const splits = transaction.splits ?? [];
        if (splits.length <= 1) {
            const singleSplit = splits.length === 1 ? splits[0] : null;
            return [{
                rowId: transaction.id,
                parentId: transaction.id,
                transaction,
                splitId: null,
                splitIndex: null,
                isSplitChild: false,
                amount: transaction.amount,
                note: noteWithHashtags(singleSplit?.note ?? transaction.note ?? "", transaction.hashtags),
                category: singleSplit?.category ?? categoryFromTransaction(transaction)
            }];
        }
        return splits.map((split, index) => ({
            rowId: `${transaction.id}::${split.id}`,
            parentId: transaction.id,
            transaction,
            splitId: split.id,
            splitIndex: index,
            isSplitChild: true,
            amount: split.amount,
            note: noteWithHashtags(split.note ?? "", []),
            category: split.category
        }));
    });
}

function compareText(left: string, right: string): number {
    return left.localeCompare(right, "da", { sensitivity: "base" });
}

function transactionSortValue(transaction: NordeaTransaction, sortKey: SortKey): string | number {
    if (sortKey === "booking_date") {
        return transaction.booking_date || "";
    }
    if (sortKey === "description") {
        return transaction.description || "";
    }
    if (sortKey === "category") {
        return categoryLabel(transaction);
    }
    return transaction.amount;
}

function CategorySelect({
    categories,
    value,
    onChange,
    allowMainSelection = false,
    disabled = false,
    placeholder = "Vælg kategori",
    autoFocus = false,
    selectValueOnFocus = false,
    openOnFocus = true,
    searchOnly = false,
    bubbleClosedTableKeys = false
}: {
    categories: NordeaCategoryOption[];
    value: string;
    onChange: (category: NordeaCategoryOption | null) => void;
    allowMainSelection?: boolean;
    disabled?: boolean;
    placeholder?: string;
    autoFocus?: boolean;
    selectValueOnFocus?: boolean;
    openOnFocus?: boolean;
    searchOnly?: boolean;
    bubbleClosedTableKeys?: boolean;
}) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const pickerRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const mainButtonRefs = useRef(new Map<string, HTMLButtonElement>());
    const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
    const [submenuStyle, setSubmenuStyle] = useState<CSSProperties>({});
    const normalizedQuery = query.trim().toLowerCase();
    const categoryGroups = useMemo(() => {
        const byMain = new Map<string, NordeaCategoryOption[]>();
        categories.forEach((category) => {
            const mainName = spiirMenuMainName(category);
            byMain.set(mainName, [...(byMain.get(mainName) ?? []), category]);
        });
        return Array.from(byMain.entries())
            .map(([mainName, groupCategories]) => ({
                mainName,
                usageCount: groupCategories.reduce((total, category) => total + category.usage_count, 0),
                categories: groupCategories.sort((left, right) => {
                    const order = SPIIR_SUBCATEGORY_ORDER[mainName] ?? [];
                    return categoryOrderIndex(left.categoryName, order) - categoryOrderIndex(right.categoryName, order)
                        || String(left.categoryName).localeCompare(String(right.categoryName), "da");
                })
            }))
            .sort((left, right) => categoryOrderIndex(left.mainName, SPIIR_MAIN_CATEGORY_ORDER) - categoryOrderIndex(right.mainName, SPIIR_MAIN_CATEGORY_ORDER)
                || left.mainName.localeCompare(right.mainName, "da"));
    }, [categories]);
    const currentCategory = useMemo(() => {
        const directMatch = categories.find((category) => categoryKey(category) === value) ?? null;
        if (directMatch || !allowMainSelection || !value.includes("|__main__::")) {
            return directMatch;
        }
        const [mainCategoryId] = value.split("|");
        const group = categoryGroups.find((item) => String(item.categories[0]?.mainCategoryId ?? "") === mainCategoryId);
        if (!group) {
            return null;
        }
        return buildMainCategoryOption(
            group.categories[0]?.mainCategoryId,
            group.mainName,
            group.categories[0]?.categoryType ?? "Expense",
            group.usageCount,
        );
    }, [allowMainSelection, categories, categoryGroups, value]);
    const [activeMainName, setActiveMainName] = useState<string>("");
    const [keyboardScope, setKeyboardScope] = useState<"main" | "sub" | "search">("main");
    const [highlightedIndex, setHighlightedIndex] = useState(0);
    const [highlightedSubIndex, setHighlightedSubIndex] = useState(0);
    const activeGroup = categoryGroups.find((group) => group.mainName === activeMainName) ?? categoryGroups[0] ?? null;
    const activeMainIndex = Math.max(0, categoryGroups.findIndex((group) => group.mainName === (activeGroup?.mainName ?? "")));
    const allCategories = categoryGroups.flatMap((group) => group.categories);
    const searchResults = useMemo(() => {
        if (!normalizedQuery) {
            return [];
        }
        const results: { category: NordeaCategoryOption; alias: string; ranking: number }[] = [];
        for (const category of allCategories) {
            const labelRanking = spiirSearchRank(category.categoryName, normalizedQuery);
            if (labelRanking > 0) {
                results.push({ category, alias: "", ranking: labelRanking });
            } else {
                for (const alias of SPIIR_CATEGORY_ALIASES[category.categoryName] ?? []) {
                    const aliasRanking = spiirSearchRank(alias, normalizedQuery);
                    if (aliasRanking > 0) {
                        results.push({ category, alias, ranking: aliasRanking });
                    }
                }
            }
            if (results.length >= 10) {
                break;
            }
        }
        return results.sort((left, right) => right.ranking - left.ranking);
    }, [allCategories, normalizedQuery]);
    const filteredCategories = normalizedQuery ? searchResults.map((result) => result.category) : searchOnly ? [] : allCategories;
    const keyboardOptions = useMemo(() => {
        if (normalizedQuery) {
            return searchResults.map((result) => result.category);
        }
        if (searchOnly) {
            return [];
        }
        if (!activeGroup) {
            return [];
        }
        return activeGroup.categories;
    }, [activeGroup, normalizedQuery, searchOnly, searchResults]);

    useEffect(() => {
        if (!open) {
            return undefined;
        }
        function positionMenu(): void {
            const picker = pickerRef.current;
            if (!picker) {
                return;
            }
            const rect = picker.getBoundingClientRect();
            const menuHeight = (normalizedQuery ? Math.max(searchResults.length, 1) : categoryGroups.length) * 31 + 2;
            const opensBelow = rect.bottom + menuHeight <= window.innerHeight || rect.top < menuHeight;
            const top = opensBelow
                ? rect.bottom + window.scrollY - 1
                : Math.max(window.scrollY + 8, rect.top + window.scrollY - menuHeight + 1);
            setMenuStyle({
                left: rect.left + window.scrollX,
                top,
                width: picker.clientWidth,
            });
        }
        function closeOnOutsideClick(event: MouseEvent): void {
            const target = event.target as Node;
            if (!pickerRef.current?.contains(target) && !menuRef.current?.contains(target)) {
                setOpen(false);
            }
        }
        positionMenu();
        window.addEventListener("resize", positionMenu);
        document.addEventListener("mousedown", closeOnOutsideClick);
        return () => {
            window.removeEventListener("resize", positionMenu);
            document.removeEventListener("mousedown", closeOnOutsideClick);
        };
    }, [open, normalizedQuery, searchResults.length, categoryGroups.length]);

    useEffect(() => {
        if (!open) {
            return;
        }
        const currentMainName = currentCategory ? spiirMenuMainName(currentCategory) : "";
        if (currentMainName && categoryGroups.some((group) => group.mainName === currentMainName)) {
            setActiveMainName(currentMainName);
            return;
        }
        setActiveMainName((current) => categoryGroups.some((group) => group.mainName === current) ? current : categoryGroups[0]?.mainName ?? "");
    }, [open, categoryGroups, currentCategory?.mainCategoryName]);

    useEffect(() => {
        setHighlightedIndex(0);
        setHighlightedSubIndex(0);
        setKeyboardScope(normalizedQuery ? "search" : "main");
    }, [open, normalizedQuery, activeGroup?.mainName]);

    useEffect(() => {
        setHighlightedIndex((current) => {
            if (keyboardOptions.length === 0) {
                return 0;
            }
            return Math.min(current, keyboardOptions.length - 1);
        });
    }, [keyboardOptions]);

    useEffect(() => {
        setHighlightedSubIndex((current) => {
            const subCount = activeGroup?.categories.length ?? 0;
            if (subCount === 0) {
                return 0;
            }
            return Math.min(current, subCount - 1);
        });
    }, [activeGroup?.categories.length]);

    useEffect(() => {
        if (!autoFocus || disabled) {
            return undefined;
        }
        const frame = window.requestAnimationFrame(() => {
            inputRef.current?.focus();
            if (selectValueOnFocus || searchOnly) {
                inputRef.current?.select();
            }
        });
        return () => window.cancelAnimationFrame(frame);
    }, [autoFocus, disabled, searchOnly, selectValueOnFocus]);

    useEffect(() => {
        if (!open || normalizedQuery || activeGroup?.mainName === "Ikke kategoriseret") {
            setSubmenuStyle({});
            return;
        }
        const frame = window.requestAnimationFrame(() => positionSubmenu(activeGroup?.mainName ?? ""));
        return () => window.cancelAnimationFrame(frame);
    }, [open, normalizedQuery, activeGroup?.mainName]);

    function selectCategory(category: NordeaCategoryOption): void {
        onChange(category);
        setQuery("");
        setOpen(false);
    }

    function openForInput(): void {
        if (!openOnFocus) {
            setQuery("");
            setKeyboardScope("main");
            setHighlightedIndex(0);
            setHighlightedSubIndex(0);
            if (selectValueOnFocus) {
                window.requestAnimationFrame(() => inputRef.current?.select());
            }
            return;
        }
        const nextQuery = selectValueOnFocus ? currentCategory?.categoryName ?? "" : "";
        setOpen(true);
        setQuery(nextQuery);
        setKeyboardScope(nextQuery.trim() ? "search" : "main");
        setHighlightedIndex(0);
        setHighlightedSubIndex(0);
        if (selectValueOnFocus) {
            window.requestAnimationFrame(() => inputRef.current?.select());
        }
    }

    function optionSubtitle(category: NordeaCategoryOption): string {
        const alias = normalizedQuery
            ? (category.search_aliases ?? []).find((item) => item.toLowerCase().includes(normalizedQuery))
            : null;
        return alias || "";
    }

    function positionSubmenu(mainName: string): void {
        const menu = menuRef.current;
        const button = mainButtonRefs.current.get(mainName);
        const group = categoryGroups.find((item) => item.mainName === mainName);
        if (!menu || !button || !group || mainName === "Ikke kategoriseret") {
            setSubmenuStyle({});
            return;
        }
        const menuRect = menu.getBoundingClientRect();
        const buttonRect = button.getBoundingClientRect();
        const submenuWidth = 250;
        const submenuHeight = group.categories.length * 31 + 2;
        const left = buttonRect.right + submenuWidth > window.innerWidth ? -submenuWidth : menuRect.width - 1;
        const viewportTop = buttonRect.top;
        const overflowBottom = Math.max(0, viewportTop + submenuHeight - window.innerHeight + 8);
        const overflowTop = Math.max(0, 8 - (viewportTop - overflowBottom));
        setSubmenuStyle({
            left,
            top: button.offsetTop - overflowBottom + overflowTop,
            width: submenuWidth,
        });
    }

    const categoryOptions = open && (!searchOnly || normalizedQuery) ? (
        <div className="nordea-category-options" ref={menuRef} style={menuStyle}>
            {normalizedQuery ? (
                <div className="nordea-category-search-list">
                    {searchResults.map((result) => (
                        <button
                            type="button"
                            key={`${categoryKey(result.category)}|${result.alias}`}
                            className={searchResults[highlightedIndex] === result && keyboardScope === "search" ? "active" : ""}
                            onMouseDown={(event) => event.preventDefault()}
                            onMouseEnter={() => {
                                setKeyboardScope("search");
                                setHighlightedIndex(searchResults.indexOf(result));
                            }}
                            onClick={() => selectCategory(result.category)}
                        >
                            <span>{result.category.categoryName}</span>
                            {result.alias ? <small>({result.alias})</small> : null}
                        </button>
                    ))}
                </div>
            ) : (
                <>
                    <div className="nordea-category-main-list">
                        {categoryGroups.map((group) => (
                            <button
                                type="button"
                                key={group.mainName}
                                ref={(element) => {
                                    if (element) {
                                        mainButtonRefs.current.set(group.mainName, element);
                                    } else {
                                        mainButtonRefs.current.delete(group.mainName);
                                    }
                                }}
                                className={group.mainName === activeGroup?.mainName ? "active" : ""}
                                onMouseDown={(event) => event.preventDefault()}
                                onMouseEnter={() => {
                                    setKeyboardScope("main");
                                    setActiveMainName(group.mainName);
                                    setHighlightedSubIndex(0);
                                    positionSubmenu(group.mainName);
                                }}
                                onFocus={() => {
                                    setKeyboardScope("main");
                                    setActiveMainName(group.mainName);
                                    setHighlightedSubIndex(0);
                                    positionSubmenu(group.mainName);
                                }}
                                onClick={(() => {
                                    if (allowMainSelection && group.categories[0]) {
                                        return () => selectCategory(buildMainCategoryOption(
                                            group.categories[0].mainCategoryId,
                                            group.mainName,
                                            group.categories[0].categoryType,
                                            group.usageCount,
                                        ));
                                    }
                                    if (group.mainName === "Ikke kategoriseret" && group.categories[0]) {
                                        return () => selectCategory(group.categories[0]);
                                    }
                                    return undefined;
                                })()}
                            >
                                <span>{group.mainName}</span>
                                {group.mainName === "Ikke kategoriseret" ? null : <span className="nordea-category-arrow">›</span>}
                            </button>
                        ))}
                    </div>
                        {activeGroup?.mainName === "Ikke kategoriseret" ? null : <div className="nordea-category-sub-list" style={submenuStyle}>
                        {activeGroup?.categories.map((category) => (
                            <button
                                type="button"
                                key={categoryKey(category)}
                                className={activeGroup.categories[highlightedSubIndex] === category && keyboardScope === "sub" ? "active" : ""}
                                onMouseDown={(event) => event.preventDefault()}
                                onMouseEnter={() => {
                                    setKeyboardScope("sub");
                                    setHighlightedSubIndex(activeGroup.categories.indexOf(category));
                                }}
                                onClick={() => selectCategory(category)}
                            >
                                <span>{category.categoryName}</span>
                                <small>{optionSubtitle(category)}</small>
                            </button>
                        ))}
                    </div>}
                </>
            )}
            {normalizedQuery && filteredCategories.length === 0 ? <span className="nordea-category-empty">Ingen match</span> : null}
        </div>
    ) : null;

    return (
        <div className={searchOnly ? "nordea-category-picker search-only" : "nordea-category-picker"} ref={pickerRef}>
            <input
                ref={inputRef}
                type="text"
                value={open && (!searchOnly || query) ? query : currentCategory?.categoryName ?? ""}
                disabled={disabled}
                placeholder={placeholder}
                onFocus={openForInput}
                onClick={() => {
                    if (!openOnFocus) {
                        setOpen(true);
                    }
                    if (searchOnly && !query) {
                        inputRef.current?.select();
                    }
                }}
                onChange={(event) => {
                    setQuery(event.target.value);
                    setOpen(true);
                    setKeyboardScope(event.target.value.trim() ? "search" : "main");
                    setHighlightedIndex(0);
                    setHighlightedSubIndex(0);
                }}
                onKeyDown={(event) => {
                    if (bubbleClosedTableKeys && !open && ["ArrowDown", "ArrowUp", "Enter"].includes(event.key)) {
                        return;
                    }
                    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                        event.preventDefault();
                        if (!open) {
                            setOpen(true);
                            return;
                        }
                        const direction = event.key === "ArrowDown" ? 1 : -1;
                        if (normalizedQuery) {
                            if (searchResults.length === 0) {
                                return;
                            }
                            setKeyboardScope("search");
                            setHighlightedIndex((current) => {
                                const next = current + direction;
                                if (next < 0) {
                                    return searchResults.length - 1;
                                }
                                if (next >= searchResults.length) {
                                    return 0;
                                }
                                return next;
                            });
                            return;
                        }
                        if (searchOnly) {
                            return;
                        }
                        if (keyboardScope === "sub") {
                            const subCount = activeGroup?.categories.length ?? 0;
                            if (subCount === 0) {
                                return;
                            }
                            setHighlightedSubIndex((current) => {
                                const next = current + direction;
                                if (next < 0) {
                                    return subCount - 1;
                                }
                                if (next >= subCount) {
                                    return 0;
                                }
                                return next;
                            });
                            return;
                        }
                        if (categoryGroups.length === 0) {
                            return;
                        }
                        const nextMainIndex = (() => {
                            const next = activeMainIndex + direction;
                            if (next < 0) {
                                return categoryGroups.length - 1;
                            }
                            if (next >= categoryGroups.length) {
                                return 0;
                            }
                            return next;
                        })();
                        const nextMain = categoryGroups[nextMainIndex];
                        setKeyboardScope("main");
                        setActiveMainName(nextMain.mainName);
                        setHighlightedSubIndex(0);
                        positionSubmenu(nextMain.mainName);
                        return;
                    }
                    if (event.key === "ArrowRight" && !normalizedQuery) {
                        if (searchOnly) {
                            return;
                        }
                        if (!open) {
                            setOpen(true);
                            return;
                        }
                        if (!activeGroup || activeGroup.mainName === "Ikke kategoriseret") {
                            return;
                        }
                        event.preventDefault();
                        setKeyboardScope("sub");
                        setHighlightedSubIndex(0);
                        positionSubmenu(activeGroup.mainName);
                        return;
                    }
                    if (event.key === "ArrowLeft" && !normalizedQuery && keyboardScope === "sub") {
                        event.preventDefault();
                        setKeyboardScope("main");
                        return;
                    }
                    if (event.key === "Escape") {
                        setOpen(false);
                    }
                    if (event.key === "Enter") {
                        event.preventDefault();
                        if (normalizedQuery) {
                            const match = searchResults[highlightedIndex]?.category;
                            if (match) {
                                selectCategory(match);
                            }
                            return;
                        }
                        if (searchOnly) {
                            return;
                        }
                        if (keyboardScope === "sub") {
                            const subCategory = activeGroup?.categories[highlightedSubIndex];
                            if (subCategory) {
                                selectCategory(subCategory);
                            }
                            return;
                        }
                        if (!activeGroup) {
                            return;
                        }
                        if (allowMainSelection && activeGroup.categories[0]) {
                            selectCategory(
                                buildMainCategoryOption(
                                    activeGroup.categories[0].mainCategoryId,
                                    activeGroup.mainName,
                                    activeGroup.categories[0].categoryType,
                                    activeGroup.usageCount,
                                )
                            );
                            return;
                        }
                        if (activeGroup.mainName === "Ikke kategoriseret" && activeGroup.categories[0]) {
                            selectCategory(activeGroup.categories[0]);
                            return;
                        }
                        setKeyboardScope("sub");
                        setHighlightedSubIndex(0);
                        positionSubmenu(activeGroup.mainName);
                    }
                }}
                onBlur={() => window.setTimeout(() => setOpen(false), 120)}
            />
            {searchOnly ? null : (
                <button
                    type="button"
                    disabled={disabled}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                        setOpen((current) => {
                            const nextOpen = !current;
                            if (nextOpen) {
                                setQuery("");
                                window.setTimeout(() => inputRef.current?.focus(), 0);
                            }
                            return nextOpen;
                        });
                    }}
                    aria-label="Vis kategorier"
                >
                    ▾
                </button>
            )}
            {categoryOptions ? createPortal(categoryOptions, document.body) : null}
        </div>
    );
}

function HashtagTextarea({
    value,
    hashtags,
    rows,
    placeholder,
    onChange,
    onKeyDown,
}: {
    value: string;
    hashtags: NordeaHashtagOption[];
    rows?: number;
    placeholder?: string;
    onChange: (value: string) => void;
    onKeyDown?: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
}) {
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const nextSelectionRef = useRef<number | null>(null);
    const [caret, setCaret] = useState<number | null>(null);
    const [highlightedIndex, setHighlightedIndex] = useState(0);
    const token = activeHashtagToken(value, caret);
    const suggestions = useMemo(() => {
        if (!token) {
            return [];
        }
        return matchingHashtagSuggestions(hashtags, token.prefix);
    }, [hashtags, token?.prefix, token?.start]);

    useEffect(() => {
        setHighlightedIndex(0);
    }, [token?.prefix, token?.start]);

    useEffect(() => {
        const nextSelection = nextSelectionRef.current;
        if (nextSelection === null) {
            return;
        }
        nextSelectionRef.current = null;
        const frame = window.requestAnimationFrame(() => {
            textareaRef.current?.focus();
            textareaRef.current?.setSelectionRange(nextSelection, nextSelection);
            setCaret(nextSelection);
        });
        return () => window.cancelAnimationFrame(frame);
    }, [value]);

    function updateCaret(element: HTMLTextAreaElement): void {
        setCaret(element.selectionStart);
    }

    function selectSuggestion(hashtag: NordeaHashtagOption): void {
        if (!token || caret === null) {
            return;
        }
        const beforeToken = value.slice(0, token.start);
        const afterToken = value.slice(caret);
        const nextValue = `${beforeToken}#${hashtag.name}${afterToken}`;
        const nextCaret = beforeToken.length + hashtag.name.length + 1;
        nextSelectionRef.current = nextCaret;
        onChange(nextValue);
    }

    return (
        <div className="nordea-note-suggest-wrap">
            <textarea
                ref={textareaRef}
                value={value}
                rows={rows}
                placeholder={placeholder}
                onChange={(event) => {
                    onChange(event.target.value);
                    updateCaret(event.target);
                }}
                onClick={(event) => updateCaret(event.currentTarget)}
                onKeyUp={(event) => updateCaret(event.currentTarget)}
                onBlur={() => window.setTimeout(() => setCaret(null), 120)}
                onKeyDown={(event) => {
                    if (suggestions.length > 0) {
                        if (event.key === "ArrowDown") {
                            event.preventDefault();
                            setHighlightedIndex((current) => (current + 1) % suggestions.length);
                            return;
                        }
                        if (event.key === "ArrowUp") {
                            event.preventDefault();
                            setHighlightedIndex((current) => (current - 1 + suggestions.length) % suggestions.length);
                            return;
                        }
                        if (event.key === "Enter" || event.key === "Tab") {
                            event.preventDefault();
                            selectSuggestion(suggestions[highlightedIndex]);
                            return;
                        }
                        if (event.key === "Escape") {
                            event.preventDefault();
                            setCaret(null);
                            return;
                        }
                    }
                    onKeyDown?.(event);
                }}
            />
            {suggestions.length > 0 ? (
                <div className="nordea-note-suggest-list">
                    {suggestions.map((hashtag, index) => (
                        <button
                            type="button"
                            key={hashtag.name}
                            className={index === highlightedIndex ? "active" : ""}
                            onMouseDown={(event) => event.preventDefault()}
                            onMouseEnter={() => setHighlightedIndex(index)}
                            onClick={() => selectSuggestion(hashtag)}
                        >
                            {highlightedHashtagName(hashtag.name, token?.prefix ?? "")}
                        </button>
                    ))}
                </div>
            ) : null}
        </div>
    );
}

function NoteEditor({
    entityId,
    note,
    hashtags,
    saving,
    onSave
}: {
    entityId: string;
    note: string;
    hashtags: NordeaHashtagOption[];
    saving: boolean;
    onSave: (note: string) => void;
}) {
    const [noteText, setNoteText] = useState(note);
    const saveButtonRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        setNoteText(note);
    }, [entityId, note]);

    return (
        <>
            <HashtagTextarea
                value={noteText}
                hashtags={hashtags}
                onChange={setNoteText}
                onKeyDown={(event) => {
                    if (event.key === "Tab" && !event.shiftKey) {
                        event.preventDefault();
                        saveButtonRef.current?.focus();
                    }
                    if (event.key === "Enter" && event.shiftKey) {
                        event.preventDefault();
                        onSave(noteText);
                    }
                }}
                placeholder="Skriv note og tags"
            />
            <button ref={saveButtonRef} type="button" disabled={saving} onClick={() => onSave(noteText)}>
                Gem
            </button>
        </>
    );
}

function SearchField({
    value,
    resetKey,
    onCommit,
    onClear
}: {
    value: string;
    resetKey: number;
    onCommit: (value: string) => void;
    onClear: () => void;
}) {
    const [draft, setDraft] = useState(value);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        setDraft(value);
        if (inputRef.current) {
            inputRef.current.value = value;
        }
    }, [value, resetKey]);

    return (
        <div className="nordea-search-input-wrap">
            <input
                ref={inputRef}
                type="search"
                value={draft}
                onChange={(event) => {
                    const nextValue = event.currentTarget.value;
                    setDraft(nextValue);
                    if (!nextValue && value) {
                        onClear();
                    }
                }}
                onKeyDown={(event) => {
                    if (event.key === "Enter") {
                        onCommit(event.currentTarget.value);
                    }
                }}
                placeholder="Skriv søgeord og tryk enter"
            />
            {draft ? (
                <button
                    type="button"
                    className="nordea-search-clear"
                    aria-label="Nulstil søgning"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                        setDraft("");
                        onClear();
                        inputRef.current?.focus();
                    }}
                >
                    x
                </button>
            ) : null}
        </div>
    );
}

function IncomeExpenseOverview({ series, onOpenSunburst }: { series: SpiirIncomeExpenseSeriesResponse | null; onOpenSunburst: (month: string) => void }) {
    const [periodLabel, setPeriodLabel] = useState("12 mdr.");
    const [hoveredMonth, setHoveredMonth] = useState<string | null>(null);
    const monthMap = useMemo(() => new Map((series?.months ?? []).map((month) => [month.month, month])), [series?.months]);
    const defaultPeriod = series?.periods.find((period) => period.label === "12 mdr.") ?? series?.periods[0];
    const activePeriod = series?.periods.find((period) => period.label === periodLabel) ?? defaultPeriod;
    const desktopMonths = useMemo(() => {
        if (!series || !activePeriod) {
            return [];
        }
        return activePeriod.months.map((month) => monthMap.get(month)).filter((month): month is SpiirIncomeExpenseMonth => Boolean(month));
    }, [activePeriod, monthMap, series]);
    const mobileMonths = useMemo(() => {
        return (series?.months ?? [])
            .filter((month) => month.income !== 0 || month.expense !== 0 || month.net !== 0)
            .slice(-6);
    }, [series]);
    const [selectedMobileMonth, setSelectedMobileMonth] = useState<string | null>(null);
    const selectedMobile = mobileMonths.find((month) => month.month === selectedMobileMonth) ?? mobileMonths[mobileMonths.length - 1] ?? null;
    const hoveredIndex = desktopMonths.findIndex((month) => month.month === hoveredMonth);
    const hovered = hoveredIndex >= 0 ? desktopMonths[hoveredIndex] : null;
    const maxValue = Math.max(1, ...desktopMonths.flatMap((month) => [month.income, month.expense, Math.abs(month.net)]));
    const roundedMax = Math.ceil(maxValue / 10000) * 10000;
    const plot = { left: 60, top: 20, width: 530, height: 170 };
    const zeroY = plot.top + plot.height / 2;
    const scale = (value: number) => zeroY - (value / roundedMax) * (plot.height / 2);
    const step = desktopMonths.length > 0 ? plot.width / desktopMonths.length : plot.width;
    const barWidth = Math.min(38, Math.max(22, step * 0.55));
    const hoveredCenterX = hoveredIndex >= 0 ? plot.left + step * hoveredIndex + step / 2 : null;
    const tooltipStyle = hoveredCenterX === null ? undefined : ({
        "--nordea-income-tooltip-x": `${(hoveredCenterX / 650) * 100}%`,
    } as CSSProperties);
    const mobileMax = Math.max(1, ...mobileMonths.flatMap((month) => [month.income, month.expense]));
    const mobileAverageIncome = mobileMonths.length ? mobileMonths.reduce((sum, month) => sum + month.income, 0) / mobileMonths.length : 0;
    const mobileAverageExpense = mobileMonths.length ? mobileMonths.reduce((sum, month) => sum + month.expense, 0) / mobileMonths.length : 0;

    useEffect(() => {
        if (!selectedMobileMonth && mobileMonths.length > 0) {
            setSelectedMobileMonth(mobileMonths[mobileMonths.length - 1].month);
        }
    }, [mobileMonths, selectedMobileMonth]);

    useEffect(() => {
        if (series && !series.periods.some((period) => period.label === periodLabel)) {
            setPeriodLabel(series.periods[0]?.label ?? "12 mdr.");
        }
    }, [periodLabel, series]);

    if (!series || series.months.length === 0) {
        return null;
    }

    return (
        <section className="nordea-income-overview" aria-label="Indkomst og udgifter">
            <div className="nordea-income-desktop">
                <div className="nordea-income-chart-head">
                    <select value={activePeriod?.label ?? periodLabel} onChange={(event) => setPeriodLabel(event.target.value)}>
                        {series.periods.map((period) => (
                            <option key={period.label} value={period.label}>{period.label}</option>
                        ))}
                    </select>
                </div>
                <div className="nordea-income-svg-wrap" onMouseLeave={() => setHoveredMonth(null)}>
                    <svg viewBox="0 0 650 220" role="img" aria-label="Indkomst og udgifter pr. måned">
                        {[-roundedMax, 0, roundedMax].map((tick) => {
                            const y = scale(tick);
                            return (
                                <g key={tick}>
                                    <line x1={plot.left} x2={plot.left + plot.width} y1={y} y2={y} className="nordea-income-grid" />
                                    <text x={plot.left - 8} y={y + 4} textAnchor="end" className="nordea-income-axis-label">{formatChartAmount(tick)}</text>
                                </g>
                            );
                        })}
                        {desktopMonths.map((month, index) => {
                            const centerX = plot.left + step * index + step / 2;
                            const incomeY = scale(month.income);
                            const expenseY = scale(-month.expense);
                            const isHover = hoveredMonth === month.month;
                            return (
                                <g key={month.month} onMouseEnter={() => setHoveredMonth(month.month)}>
                                    <rect x={centerX - barWidth / 2} y={incomeY} width={barWidth} height={zeroY - incomeY} className={month.is_current_month ? "nordea-income-bar current" : "nordea-income-bar"} />
                                    <rect x={centerX - barWidth / 2} y={zeroY} width={barWidth} height={expenseY - zeroY} className={month.is_current_month ? "nordea-expense-bar current" : "nordea-expense-bar"} />
                                    <line x1={centerX} x2={centerX} y1={zeroY} y2={zeroY + 5} className="nordea-income-tick" />
                                    <text x={centerX} y={plot.top + plot.height + 20} textAnchor="middle" className="nordea-income-axis-label">{shortMonthLabel(month.month)}</text>
                                    <rect
                                        x={centerX - step / 2}
                                        y={plot.top}
                                        width={step}
                                        height={plot.height}
                                        className={isHover ? "nordea-income-hover-zone active clickable" : "nordea-income-hover-zone clickable"}
                                        role="button"
                                        tabIndex={0}
                                        aria-label={`Åbn Spiir sunburst for ${longMonthLabel(month.month)}`}
                                        onClick={() => onOpenSunburst(month.month)}
                                        onKeyDown={(event) => {
                                            if (event.key === "Enter" || event.key === " ") {
                                                event.preventDefault();
                                                onOpenSunburst(month.month);
                                            }
                                        }}
                                    />
                                </g>
                            );
                        })}
                        <polyline
                            points={desktopMonths.map((month, index) => `${plot.left + step * index + step / 2},${scale(month.net)}`).join(" ")}
                            className="nordea-net-line"
                        />
                        {desktopMonths.map((month, index) => {
                            const centerX = plot.left + step * index + step / 2;
                            const y = scale(month.net);
                            const isHover = hoveredMonth === month.month;
                            return (
                                <circle
                                    key={month.month}
                                    cx={centerX}
                                    cy={y}
                                    r={isHover ? 6 : 4}
                                    className={isHover ? "nordea-net-point active clickable" : "nordea-net-point clickable"}
                                    role="button"
                                    tabIndex={0}
                                    aria-label={`Åbn Spiir sunburst for ${longMonthLabel(month.month)}`}
                                    onClick={() => onOpenSunburst(month.month)}
                                    onKeyDown={(event) => {
                                        if (event.key === "Enter" || event.key === " ") {
                                            event.preventDefault();
                                            onOpenSunburst(month.month);
                                        }
                                    }}
                                />
                            );
                        })}
                    </svg>
                    {hovered ? (
                        <div className="nordea-income-tooltip" style={tooltipStyle}>
                            <div>
                                <small>{longMonthLabel(hovered.month)}</small>
                                <span>RESULTAT</span>
                                <strong>{formatWholeDkk(hovered.net)}</strong>
                            </div>
                            <div>
                                <small>Overblik</small>
                                <p><span>Indkomst</span><strong>{formatWholeDkk(hovered.income)}</strong></p>
                                <p><span>Udgifter</span><strong>{formatWholeDkk(hovered.expense)}</strong></p>
                                <p><span>Resultat</span><strong>{formatWholeDkk(hovered.net)}</strong></p>
                            </div>
                        </div>
                    ) : null}
                </div>
            </div>
            <div className="nordea-income-mobile">
                {selectedMobile ? (
                    <div className="nordea-income-mobile-head">
                        <div><span>{monthLabel(selectedMobile.month)}</span><strong>{formatWholeDkk(selectedMobile.income)}</strong><small>Gns. {formatWholeDkk(mobileAverageIncome)}</small></div>
                        <div><span>Udgifter</span><strong>{formatWholeDkk(selectedMobile.expense)}</strong><small>Gns. {formatWholeDkk(mobileAverageExpense)}</small></div>
                    </div>
                ) : null}
                <div className="nordea-income-mobile-bars">
                    {mobileMonths.map((month) => (
                        <button key={month.month} type="button" className={selectedMobile?.month === month.month ? "active" : ""} onClick={() => setSelectedMobileMonth(month.month)}>
                            <span className="nordea-income-mobile-bar-stack">
                                <i className="income" style={{ height: `${Math.max(2, (month.income / mobileMax) * 74)}px` }} />
                                <i className="expense" style={{ height: `${Math.max(2, (month.expense / mobileMax) * 74)}px` }} />
                            </span>
                            <span>{shortMonthLabel(month.month)}</span>
                        </button>
                    ))}
                </div>
            </div>
        </section>
    );
}

function MobileReviewRow({
    row,
    expanded,
    categories,
    hashtags,
    editControlsDisabled,
    onOpen,
    onClose,
    onCategoryChange,
    onSplit,
}: {
    row: NordeaDisplayRow;
    expanded: boolean;
    categories: NordeaCategoryOption[];
    hashtags: NordeaHashtagOption[];
    editControlsDisabled: boolean;
    onOpen: (row: NordeaDisplayRow, focusCategoryInput?: boolean) => void;
    onClose: (row: NordeaDisplayRow, note: string) => void;
    onCategoryChange: (row: NordeaDisplayRow, category: NordeaCategoryOption) => void;
    onSplit: (row: NordeaDisplayRow) => void;
}) {
    const [noteText, setNoteText] = useState(row.note);
    const note = row.note.trim();
    const pending = isPendingReview(row.transaction);

    useEffect(() => {
        if (expanded) {
            setNoteText(row.note);
        }
    }, [expanded, row.note, row.rowId]);

    return (
        <article
            id={`nordea-mobile-row-${row.rowId}`}
            className={[
                "nordea-mobile-row",
                expanded ? "expanded" : null,
                !expanded && pending ? "pending" : null,
                isTransferCategory(row.category) ? "transfer" : null,
            ].filter(Boolean).join(" ")}
            onClick={() => onOpen(row, !expanded && isUncategorizedCategory(row.category))}
        >
            <div className="nordea-mobile-row-main">
                <div className="nordea-mobile-row-text">
                    <strong>{row.transaction.description}</strong>
                    <span>{isUncategorizedCategory(row.category) ? "Ikke kategoriseret" : categoryLabelForRow(row)}</span>
                    {note ? <em>{note}</em> : null}
                </div>
                <div className="nordea-mobile-row-meta">
                    <strong className={row.amount > 0 ? "positive" : ""}>{formatMobileAmount(row.amount)}</strong>
                    <span>{formatMobileTxDate(row.transaction.booking_date)}</span>
                    <div className="nordea-mobile-markers">
                        {pending ? <small>Pending</small> : null}
                        {row.isSplitChild ? <small>Split</small> : null}
                        {row.transaction.is_extraordinary ? <small>Ekstra</small> : null}
                    </div>
                </div>
            </div>
            {expanded ? (
                <div className="nordea-mobile-row-editor" onClick={(event) => event.stopPropagation()}>
                    <label>
                        Kategori
                        <CategorySelect
                            categories={categories}
                            value={isUncategorizedCategory(row.category) ? "" : categoryKey(row.category)}
                            onChange={(category) => category ? onCategoryChange(row, category) : undefined}
                            disabled={editControlsDisabled || categories.length === 0}
                            placeholder="Skriv fx bluse"
                            autoFocus
                            searchOnly
                        />
                    </label>
                    <label>
                        Note
                        <HashtagTextarea value={noteText} hashtags={hashtags} onChange={setNoteText} rows={3} placeholder="Skriv note og tags" />
                    </label>
                    <div className="nordea-mobile-row-actions">
                        <button type="button" className="nordea-mobile-split-action" onClick={() => onSplit(row)} disabled={editControlsDisabled}>
                            Split
                        </button>
                        <button type="button" onClick={() => onClose(row, noteText)} disabled={editControlsDisabled}>
                            Done
                        </button>
                    </div>
                </div>
            ) : null}
        </article>
    );
}

function SortHeader({
    label,
    sortKey,
    activeSortKey,
    direction,
    onSort
}: {
    label: string;
    sortKey: SortKey;
    activeSortKey: SortKey;
    direction: SortDirection;
    onSort: (sortKey: SortKey) => void;
}) {
    const active = sortKey === activeSortKey;
    return (
        <button type="button" className={active ? "nordea-sort-header active" : "nordea-sort-header"} onClick={() => onSort(sortKey)}>
            <span>{label}</span>
            <span aria-hidden="true">{active ? (direction === "asc" ? "▲" : "▼") : ""}</span>
        </button>
    );
}

export default function NordeaDashboard({
    active,
    source = "nordea",
    embedded = false,
    initialFilter = null,
    onClose,
}: {
    active: boolean;
    source?: "nordea" | "local-ledger";
    embedded?: boolean;
    initialFilter?: NordeaDrilldownFilter | null;
    onClose?: () => void;
}) {
    const isLocalLedgerSource = source === "local-ledger";
    const [data, setData] = useState<NordeaTransactionsResponse | null>(null);
    const [taxonomy, setTaxonomy] = useState<NordeaTaxonomyResponse>({ categories: [], hashtags: [] });
    const [loading, setLoading] = useState(false);
    const [retrieving, setRetrieving] = useState(false);
    const [retrieveChecking, setRetrieveChecking] = useState(false);
    const [retrievePanelOpen, setRetrievePanelOpen] = useState(false);
    const [retrieveProgress, setRetrieveProgress] = useState(0);
    const [retrieveExpectedMs, setRetrieveExpectedMs] = useState(120000);
    const [retrieveStartedAt, setRetrieveStartedAt] = useState<number | null>(null);
    const [retrieveJobStatus, setRetrieveJobStatus] = useState<NordeaRetrieveJobStatus | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [spiirStatus, setSpiirStatus] = useState<SpiirStatusResponse | null>(null);
    const [incomeExpenseSeries, setIncomeExpenseSeries] = useState<SpiirIncomeExpenseSeriesResponse | null>(null);
    const [spiirOverview, setSpiirOverview] = useState<SpiirOverviewResponse | null>(null);
    const [spiirTransactions, setSpiirTransactions] = useState<SpiirTransaction[] | null>(null);
    const [sunburstState, setSunburstState] = useState<SunburstState>(null);
    const [sunburstDrilldownModal, setSunburstDrilldownModal] = useState<NordeaDrilldownFilter | null>(null);
    const [periodFilter, setPeriodFilter] = useState<PeriodFilter>(initialFilter?.periodFilter ?? "all");
    const [customPeriodStart, setCustomPeriodStart] = useState(initialFilter?.periodStart ?? "");
    const [customPeriodEnd, setCustomPeriodEnd] = useState(initialFilter?.periodEnd ?? "");
    const [visibilityFilter, setVisibilityFilter] = useState<VisibilityFilter>(initialFilter?.visibilityFilter ?? "all");
    const [categoryFilter, setCategoryFilter] = useState<NordeaCategoryOption | null>(initialFilter?.categoryFilter ?? null);
    const [showTransfersAlways, setShowTransfersAlways] = useState(true);
    const [visibilityPanelOpen, setVisibilityPanelOpen] = useState(false);
    const [searchText, setSearchText] = useState(initialFilter?.searchText ?? "");
    const [searchResetKey, setSearchResetKey] = useState(0);
    const [sortKey, setSortKey] = useState<SortKey>("booking_date");
    const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
    const [page, setPage] = useState(1);
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [pendingSaveCount, setPendingSaveCount] = useState(0);
    const [buildingSpiir, setBuildingSpiir] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const [allTransactionsLoaded, setAllTransactionsLoaded] = useState(false);
    const [bulkHashtag, setBulkHashtag] = useState("");
    const [dateText, setDateText] = useState("");
    const [isExtraordinary, setIsExtraordinary] = useState(false);
    const [splitModalOpen, setSplitModalOpen] = useState(false);
    const [splitLines, setSplitLines] = useState<SplitDraftLine[]>([]);
    const [splitError, setSplitError] = useState<string | null>(null);
    const [mobilePendingOnly, setMobilePendingOnly] = useState(false);
    const [isMobileLayout, setIsMobileLayout] = useState(() => window.matchMedia(MOBILE_LAYOUT_MEDIA_QUERY).matches);
    const [mobileRenderLimit, setMobileRenderLimit] = useState(MOBILE_RENDER_INITIAL_LIMIT);
    const [expandedMobileRowId, setExpandedMobileRowId] = useState<string | null>(null);
    const [pinnedDrilldownRowIds, setPinnedDrilldownRowIds] = useState<Set<string> | null>(null);
    const fetchAllPromiseRef = useRef<Promise<void> | null>(null);
    const fetchAllGenerationRef = useRef(0);
    const loadRequestIdRef = useRef(0);
    const tableContainerRef = useRef<HTMLDivElement>(null);
    const editPanelRef = useRef<HTMLElement>(null);
    const mobileLoadMoreRef = useRef<HTMLDivElement>(null);
    const visibilityButtonRef = useRef<HTMLButtonElement>(null);
    const visibilityPanelRef = useRef<HTMLDivElement>(null);
    const lastSelectedRowIdRef = useRef<string | null>(null);
    const keyboardSelectionStartRef = useRef<number | null>(null);
    const keyboardSelectionEndRef = useRef<number | null>(null);
    const saveQueueRef = useRef<Promise<unknown>>(Promise.resolve());
    const [editPanelTop, setEditPanelTop] = useState(0);
    const saving = pendingSaveCount > 0;
    const editControlsDisabled = saving && !isLocalLedgerSource;

    async function loadTransactions(options?: { limit?: number; offset?: number }): Promise<NordeaTransactionsResponse> {
        if (isLocalLedgerSource) {
            return getSpiirLocalLedgerTransactionsPage(options);
        }
        return getNordeaTransactions();
    }

    async function ensureAllTransactionsLoaded(): Promise<void> {
        if (!isLocalLedgerSource || allTransactionsLoaded || data === null) {
            return;
        }
        if (fetchAllPromiseRef.current !== null) {
            await fetchAllPromiseRef.current;
            return;
        }
        const promise = (async () => {
            const generation = fetchAllGenerationRef.current;
            setLoadingMore(true);
            try {
                if (data.transactions.length >= (data.transaction_count ?? data.transactions.length)) {
                    setAllTransactionsLoaded(true);
                    return;
                }
                const nextData = await getSpiirLocalLedgerTransactions();
                if (generation !== fetchAllGenerationRef.current) {
                    return;
                }
                setData(nextData);
                setAllTransactionsLoaded(true);
            } finally {
                setLoadingMore(false);
            }
        })();
        fetchAllPromiseRef.current = promise;
        try {
            await promise;
        } finally {
            fetchAllPromiseRef.current = null;
        }
    }

    function resetSearchToLatest(): void {
        setSearchText("");
        setSearchResetKey((current) => current + 1);
        setMobilePendingOnly(false);
        setPage(1);
        if (!isLocalLedgerSource) {
            return;
        }
        if (allTransactionsLoaded) {
            return;
        }
        fetchAllGenerationRef.current += 1;
        setData((current) => {
            if (!current || current.transactions.length <= LOCAL_LEDGER_INITIAL_LIMIT) {
                return current;
            }
            return {
                ...current,
                transactions: current.transactions.slice(0, LOCAL_LEDGER_INITIAL_LIMIT),
                loaded_count: LOCAL_LEDGER_INITIAL_LIMIT,
                offset: 0,
                limit: LOCAL_LEDGER_INITIAL_LIMIT,
                has_more: (current.transaction_count ?? current.transactions.length) > LOCAL_LEDGER_INITIAL_LIMIT,
            };
        });
        setAllTransactionsLoaded(false);
    }

    async function handleLoadMoreTransactions(): Promise<void> {
        if (!isLocalLedgerSource || data === null || allTransactionsLoaded || loadingMore) {
            return;
        }
        setError(null);
        try {
            await ensureAllTransactionsLoaded();
        } catch (loadError) {
            setError(loadError instanceof Error ? loadError.message : "Kunne ikke hente flere transaktioner");
        }
    }

    async function load(): Promise<void> {
        const requestId = loadRequestIdRef.current + 1;
        loadRequestIdRef.current = requestId;
        setError(null);
        setNotice(null);
        setLoading(true);
        try {
            const transactionsPromise = isLocalLedgerSource
                ? loadTransactions(localLedgerFirstPage(LOCAL_LEDGER_INITIAL_LIMIT))
                : loadTransactions();
            void getNordeaTaxonomy()
                .then((nextTaxonomy) => {
                    if (requestId !== loadRequestIdRef.current) {
                        return;
                    }
                    setTaxonomy(nextTaxonomy);
                })
                .catch((loadError) => {
                    if (requestId !== loadRequestIdRef.current) {
                        return;
                    }
                    setError(loadError instanceof Error ? loadError.message : "Kunne ikke hente Nordea metadata");
                });
            const nextData = await transactionsPromise;
            if (requestId !== loadRequestIdRef.current) {
                return;
            }
            setData(nextData);
            setAllTransactionsLoaded(!isLocalLedgerSource || computeAllTransactionsLoaded(nextData));
            void getNordeaRetrieveStatus()
                .then(async (status) => {
                    if (requestId !== loadRequestIdRef.current) {
                        return;
                    }
                    setRetrieveJobStatus(status);
                    const retrievedAt = status.result?.last_retrieved_at ?? null;
                    if (status.status === "succeeded" && retrievedAt && retrievedAt !== (nextData.last_retrieved_at ?? null)) {
                        await reloadTransactionsAfterRetrieve();
                    }
                })
                .catch(() => undefined);

            setLoading(false);
            if (isLocalLedgerSource) {
                void getSpiirStatus()
                    .then((nextStatus) => {
                        if (requestId !== loadRequestIdRef.current) {
                            return;
                        }
                        setSpiirStatus(nextStatus);
                    })
                    .catch((loadError) => {
                        if (requestId !== loadRequestIdRef.current) {
                            return;
                        }
                        setError(loadError instanceof Error ? loadError.message : "Kunne ikke hente Nordea metadata");
                    });
                void getSpiirIncomeExpenseSeries()
                    .then((series) => {
                        if (requestId !== loadRequestIdRef.current) {
                            return;
                        }
                        setIncomeExpenseSeries(series);
                    })
                    .catch((loadError) => {
                        if (requestId !== loadRequestIdRef.current) {
                            return;
                        }
                        setError(loadError instanceof Error ? loadError.message : "Kunne ikke hente indkomst/udgifter");
                    });
                return;
            }
        } catch (loadError) {
            setError(loadError instanceof Error ? loadError.message : "Kunne ikke hente transaktioner");
        } finally {
            if (requestId === loadRequestIdRef.current) {
                setLoading(false);
            }
        }
    }

    function markSpiirRebuildRequired(reason: string): void {
        invalidateSpiirCache();
        setSpiirStatus((current) => ({
            raw_exists: current?.raw_exists ?? true,
            processed_exists: current?.processed_exists ?? false,
            raw_file: current?.raw_file ?? "",
            processed_dir: current?.processed_dir ?? "",
            update_log_file: current?.update_log_file,
            generated_at: current?.generated_at ?? null,
            transaction_count: current?.transaction_count ?? 0,
            rebuild_required: true,
            rebuild_marked_at: new Date().toISOString(),
            rebuild_reason: reason,
        }));
    }

    function scheduleSpiirRebuild(delaySeconds = 10): void {
        void scheduleSpiirRebuildFromLocal(delaySeconds).catch(() => undefined);
    }

    function nordeaSyncNotice(syncResult: Pick<Awaited<ReturnType<typeof syncNordeaIntoSpiirLocalLedger>>, "created_count" | "autocategorized_count" | "updated_count">): string {
        const parts = [];
        if (syncResult.created_count > 0) {
            parts.push(`${syncResult.created_count} nye pending`);
        }
        if (syncResult.autocategorized_count > 0) {
            parts.push(`${syncResult.autocategorized_count} auto-kategoriseret`);
        }
        if (syncResult.updated_count > 0) {
            parts.push(`${syncResult.updated_count} opdaterede`);
        }
        if (parts.length === 0) {
            return "Nordea-data er opdateret: ingen nye ændringer.";
        }
        return `Nordea-data er opdateret: ${parts.join(", ")}. Spiir opdateres automatisk i baggrunden.`;
    }

    function nordeaSyncChanged(syncResult: Pick<Awaited<ReturnType<typeof syncNordeaIntoSpiirLocalLedger>>, "created_count" | "autocategorized_count" | "updated_count"> | null | undefined): boolean {
        return Boolean(syncResult && (syncResult.created_count > 0 || syncResult.autocategorized_count > 0 || syncResult.updated_count > 0));
    }

    function wait(ms: number): Promise<void> {
        return new Promise((resolve) => window.setTimeout(resolve, ms));
    }

    async function reloadTransactionsAfterRetrieve(): Promise<void> {
        invalidateLocalLedgerCache();
        const refreshed = await loadTransactions(isLocalLedgerSource ? localLedgerFirstPage(LOCAL_LEDGER_INITIAL_LIMIT) : undefined);
        setData(refreshed);
        if (isLocalLedgerSource) {
            setAllTransactionsLoaded(computeAllTransactionsLoaded(refreshed));
        }
    }

    async function pollNordeaRetrieveJob(): Promise<NordeaRetrieveJobStatus> {
        for (let attempt = 0; attempt < 180; attempt += 1) {
            const status = await getNordeaRetrieveStatus();
            setRetrieveJobStatus(status);
            setRetrieveProgress(Math.max(0, Math.min(100, status.progress)));
            if (status.status === "succeeded") {
                return status;
            }
            if (status.status === "failed") {
                throw new Error(status.error || "Nordea-hentning fejlede");
            }
            await wait(1500);
        }
        throw new Error("Nordea-hentning tager længere end forventet. Åbn siden igen om lidt for status.");
    }

    async function handleRetrieve(): Promise<void> {
        setError(null);
        setNotice(null);
        const expectedSeconds = Math.max(5, Math.min(180, data?.last_retrieve_duration_seconds ?? 120));
        setRetrieveExpectedMs(Math.round(expectedSeconds * 1000));
        setRetrieveStartedAt(Date.now());
        setRetrieveProgress(0);
        setRetrievePanelOpen(true);
        setRetrieveJobStatus(null);
        setRetrieving(true);
        try {
            setRetrieveJobStatus(await startNordeaRetrieveJob());
            const completedStatus = await pollNordeaRetrieveJob();
            await reloadTransactionsAfterRetrieve();
            invalidateSpiirCache();
            if (isLocalLedgerSource && nordeaSyncChanged(completedStatus.sync_result)) {
                markSpiirRebuildRequired("nordea_sync");
                scheduleSpiirRebuild();
            }
            if (completedStatus.sync_result) {
                setNotice(nordeaSyncNotice(completedStatus.sync_result));
            } else {
                setNotice("Nordea-data er opdateret.");
            }
        } catch (retrieveError) {
            setError(retrieveError instanceof Error ? retrieveError.message : "Kunne ikke hente fra Nordea");
        } finally {
            setRetrieving(false);
        }
    }

    async function handleAcknowledgePending(): Promise<void> {
        if (!isLocalLedgerSource || pendingParentIds.length === 0) {
            return;
        }
        if (!window.confirm(`Marker ${pendingParentIds.length} pending poster som gennemgået?`)) {
            return;
        }
        setError(null);
        setNotice(null);
        const saved = await savePatch(pendingParentIds, { pending_review: false });
        if (saved) {
            scheduleSpiirRebuild();
            setNotice("Pending-markeringer er ryddet. Spiir opdateres automatisk i baggrunden.");
        }
    }

    async function handleBuildSpiir(): Promise<void> {
        if (!isLocalLedgerSource) {
            return;
        }
        setError(null);
        setNotice(null);
        setBuildingSpiir(true);
        try {
            const result = await rebuildSpiirFromLocal();
            setSpiirStatus(await getSpiirStatus());
            setNotice(`Spiir er bygget fra ledger (${result.transaction_count} poster).`);
        } catch (buildError) {
            setError(buildError instanceof Error ? buildError.message : "Kunne ikke bygge Spiir fra ledger");
        } finally {
            setBuildingSpiir(false);
        }
    }

    async function monitorRetrieveAfterTimeout(previousLastRetrievedAt: string | null): Promise<void> {
        setRetrieveChecking(true);
        try {
            for (let attempt = 0; attempt < 12; attempt += 1) {
                await new Promise((resolve) => window.setTimeout(resolve, 5000));
                const latest = isLocalLedgerSource
                    ? await loadTransactions(localLedgerFirstPage(LOCAL_LEDGER_INITIAL_LIMIT))
                    : await loadTransactions();
                if ((latest.last_retrieved_at ?? null) !== previousLastRetrievedAt) {
                    setData(latest);
                    if (isLocalLedgerSource) {
                        setAllTransactionsLoaded(computeAllTransactionsLoaded(latest));
                    }
                    setError(null);
                    setNotice("Hentning blev færdig i baggrunden. Listen er opdateret.");
                    return;
                }
            }
            setNotice("Hentning kan stadig være i gang. Prøv at opdatere siden om lidt.");
        } catch {
            setNotice("Kunne ikke tjekke status på hentning. Prøv igen om lidt.");
        } finally {
            setRetrieveChecking(false);
        }
    }

    useEffect(() => {
        if (!retrievePanelOpen || retrieveStartedAt === null) {
            return;
        }
        if (!retrieving && !retrieveChecking) {
            setRetrieveProgress(100);
            const closeTimer = window.setTimeout(() => setRetrievePanelOpen(false), 1600);
            return () => window.clearTimeout(closeTimer);
        }
        const timer = window.setInterval(() => {
            const elapsed = Date.now() - retrieveStartedAt;
            const nextProgress = Math.min(99, Math.round((elapsed / Math.max(retrieveExpectedMs, 1)) * 100));
            setRetrieveProgress((current) => Math.max(current, nextProgress));
        }, 220);
        return () => window.clearInterval(timer);
    }, [retrievePanelOpen, retrieveStartedAt, retrieveExpectedMs, retrieving, retrieveChecking]);

    function enqueueSave(task: () => Promise<boolean>): Promise<boolean> {
        setPendingSaveCount((current) => current + 1);
        const run = saveQueueRef.current.catch(() => undefined).then(task);
        saveQueueRef.current = run.catch(() => undefined).finally(() => {
            setPendingSaveCount((current) => Math.max(0, current - 1));
        });
        return run;
    }

    function savePatch(transactionIds: string[], patch: NordeaOverridePatch): Promise<boolean> {
        setError(null);
        return enqueueSave(async () => {
            try {
                if (isLocalLedgerSource) {
                    const result = await saveSpiirLocalLedgerOverrides(transactionIds, patch);
                    markSpiirRebuildRequired("local_ledger_override");
                    setData((current) => mergeUpdatedTransactions(current, result.updated_transactions, result.deleted_transaction_ids));
                } else {
                    await saveNordeaOverrides(transactionIds, patch);
                    setData(await loadTransactions());
                }
                return true;
            } catch (saveError) {
                setError(saveError instanceof Error ? saveError.message : "Kunne ikke gemme Nordea-ændring");
                return false;
            }
        });
    }

    function toggleBulkHashtag(hashtag: string, checked: boolean): void {
        const parentIds = selectedParentIds;
        const parentIdSet = new Set(parentIds);
        setData((current) => {
            if (current === null) {
                return current;
            }
            return {
                ...current,
                transactions: current.transactions.map((transaction) => parentIdSet.has(transaction.id) ? transactionWithHashtag(transaction, hashtag, checked) : transaction),
            };
        });
        void savePatch(parentIds, checked ? { append_hashtags: [hashtag] } : { remove_hashtags: [hashtag] });
    }

    useEffect(() => {
        if (active && data === null && !loading) {
            void load();
        }
    }, [active, data, loading]);

    const requiresAllTransactions = isLocalLedgerSource && (
        embedded
        ||
        searchText.trim().length > 0
        || periodFilter !== "all"
        || visibilityFilter !== "all"
        || categoryFilter !== null
        || !showTransfersAlways
        || sortKey !== "booking_date"
        || sortDirection !== "desc"
    );

    useEffect(() => {
        if (!active || !requiresAllTransactions || allTransactionsLoaded || data === null || loadingMore) {
            return;
        }
        void ensureAllTransactionsLoaded();
    }, [active, requiresAllTransactions, allTransactionsLoaded, data, loadingMore]);

    useEffect(() => {
        if (!active || !isLocalLedgerSource || allTransactionsLoaded || data === null || loading || loadingMore) {
            return;
        }
        void ensureAllTransactionsLoaded();
    }, [active, allTransactionsLoaded, data, isLocalLedgerSource, loading, loadingMore]);

    useEffect(() => {
        if (active && !embedded) {
            window.scrollTo({ top: 0, left: window.scrollX });
        }
    }, [active, embedded]);

    useEffect(() => {
        const query = window.matchMedia(MOBILE_LAYOUT_MEDIA_QUERY);
        const updateLayout = () => setIsMobileLayout(query.matches);
        updateLayout();
        query.addEventListener("change", updateLayout);
        return () => query.removeEventListener("change", updateLayout);
    }, []);

    const transactions = data?.transactions ?? [];
    const pendingReviewCount = data?.pending_review_count ?? transactions.filter((transaction) => isPendingReview(transaction)).length;
    const displayTransactions = useMemo(() => buildDisplayRows(transactions), [transactions]);
    const selectedRows = displayTransactions.filter((row) => selectedIds.includes(row.rowId));
    const selectedParentIds = Array.from(new Set(selectedRows.map((row) => row.parentId)));
    const pendingParentIds = Array.from(new Set(transactions.filter((transaction) => isPendingReview(transaction)).map((transaction) => transaction.id)));
    const selectedRow = selectedRows.length === 1 ? selectedRows[0] : null;
    const selectedTransaction = selectedRow?.transaction ?? null;
    const selectedTotal = selectedRows.reduce((total, row) => total + row.amount, 0);
    const periodOptions = useMemo(() => {
        const months = [...new Set(transactions.map((transaction) => transaction.booking_date.slice(0, 7)).filter(Boolean))].sort().reverse();
        const years = [...new Set(months.map((month) => month.slice(0, 4)))].sort().reverse();
        return { months, years };
    }, [transactions]);
    const categoryFilterOptions = useMemo(() => {
        const byMain = new Map<string, { mainName: string; categories: NordeaCategoryOption[] }>();
        taxonomy.categories.forEach((category) => {
            const mainId = categoryMainId(category);
            const current = byMain.get(mainId) ?? {
                mainName: spiirMenuMainName(category),
                categories: [],
            };
            current.categories.push(category);
            byMain.set(mainId, current);
        });
        return Array.from(byMain.entries())
            .map(([mainId, item]) => ({
                mainId,
                mainName: item.mainName,
                categories: [...item.categories].sort((left, right) => {
                    const subOrder = SPIIR_SUBCATEGORY_ORDER[item.mainName] ?? [];
                    const orderLeft = categoryOrderIndex(left.categoryName, subOrder);
                    const orderRight = categoryOrderIndex(right.categoryName, subOrder);
                    if (orderLeft !== orderRight) {
                        return orderLeft - orderRight;
                    }
                    return compareText(left.categoryName, right.categoryName);
                }),
            }))
            .sort((left, right) => {
                const mainOrderLeft = categoryOrderIndex(left.mainName, SPIIR_MAIN_CATEGORY_ORDER);
                const mainOrderRight = categoryOrderIndex(right.mainName, SPIIR_MAIN_CATEGORY_ORDER);
                if (mainOrderLeft !== mainOrderRight) {
                    return mainOrderLeft - mainOrderRight;
                }
                return compareText(left.mainName, right.mainName);
            });
    }, [taxonomy.categories]);
    const filteredTransactions = useMemo(() => {
        const activeFilters = { periodFilter, periodStart: customPeriodStart, periodEnd: customPeriodEnd, visibilityFilter, categoryFilter, searchText, showTransfersAlways };
        if (embedded && pinnedDrilldownRowIds) {
            const needle = searchText.trim().toLowerCase();
            return displayTransactions.filter((row) => pinnedDrilldownRowIds.has(row.rowId) && (!needle || transactionTextForRow(row).toLowerCase().includes(needle)));
        }
        return displayTransactions.filter((row) => rowMatchesFilters(row, activeFilters));
    }, [categoryFilter, customPeriodEnd, customPeriodStart, displayTransactions, embedded, periodFilter, pinnedDrilldownRowIds, searchText, showTransfersAlways, visibilityFilter]);
    const pageCount = Math.max(1, Math.ceil(filteredTransactions.length / PAGE_SIZE));
    const sortedTransactions = useMemo(() => {
        return [...filteredTransactions].sort((left, right) => {
            const leftValue = transactionSortValueForRow(left, sortKey);
            const rightValue = transactionSortValueForRow(right, sortKey);
            const result = typeof leftValue === "number" && typeof rightValue === "number"
                ? leftValue - rightValue
                : compareText(String(leftValue), String(rightValue));
            return sortDirection === "asc" ? result : -result;
        });
    }, [filteredTransactions, sortDirection, sortKey]);
    const mobileTransactions = useMemo(() => {
        return mobilePendingOnly
            ? sortedTransactions.filter((row) => isPendingReview(row.transaction))
            : sortedTransactions;
    }, [mobilePendingOnly, sortedTransactions]);
    const visibleMobileTransactions = mobileTransactions.slice(0, mobileRenderLimit);
    const visibleTransactions = sortedTransactions.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    const visibleRowIds = useMemo(() => visibleTransactions.map((row) => row.rowId), [visibleTransactions]);
    const visibleRowIdSet = useMemo(() => new Set(visibleRowIds), [visibleRowIds]);
    const visibleRowIdKey = visibleRowIds.join("\u0001");
    const firstVisible = filteredTransactions.length === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
    const lastVisible = Math.min(page * PAGE_SIZE, filteredTransactions.length);
    const totals = useMemo(() => {
        const includedTransactions = filteredTransactions.filter((row) => visibilityFilter === "extraordinary" || !row.transaction.is_extraordinary);
        const amount = includedTransactions.reduce((sum, row) => sum + row.amount, 0);
        const average = includedTransactions.length > 0 ? amount / includedTransactions.length : 0;
        return { amount, average };
    }, [filteredTransactions, visibilityFilter]);
    useEffect(() => {
        setPage(1);
    }, [periodFilter, searchText, visibilityFilter, categoryFilter]);

    useEffect(() => {
        setMobileRenderLimit(MOBILE_RENDER_INITIAL_LIMIT);
    }, [categoryFilter, mobilePendingOnly, periodFilter, searchText, showTransfersAlways, sortDirection, sortKey, visibilityFilter]);

    useEffect(() => {
        if (!isMobileLayout || mobileRenderLimit >= mobileTransactions.length) {
            return;
        }
        const sentinel = mobileLoadMoreRef.current;
        if (!sentinel) {
            return;
        }
        const observer = new IntersectionObserver((entries) => {
            if (entries.some((entry) => entry.isIntersecting)) {
                setMobileRenderLimit((current) => Math.min(current + MOBILE_RENDER_INCREMENT, mobileTransactions.length));
            }
        }, { rootMargin: "300px 0px" });
        observer.observe(sentinel);
        return () => observer.disconnect();
    }, [isMobileLayout, mobileRenderLimit, mobileTransactions.length]);

    useEffect(() => {
        if (!embedded || data === null || loading) {
            return;
        }
        const activeFilters = { periodFilter, periodStart: customPeriodStart, periodEnd: customPeriodEnd, visibilityFilter, categoryFilter, searchText: "", showTransfersAlways };
        const matchingIds = displayTransactions.filter((row) => rowMatchesFilters(row, activeFilters)).map((row) => row.rowId);
        setPinnedDrilldownRowIds((current) => {
            if (current === null) {
                return new Set(matchingIds);
            }
            const next = new Set([...current, ...matchingIds]);
            return next.size === current.size ? current : next;
        });
    }, [categoryFilter, customPeriodEnd, customPeriodStart, data, displayTransactions, embedded, loading, periodFilter, showTransfersAlways, visibilityFilter]);

    useEffect(() => {
        setSelectedIds((current) => {
            const next = current.filter((id) => visibleRowIdSet.has(id));
            return next.length === current.length ? current : next;
        });
        if (lastSelectedRowIdRef.current && !visibleRowIdSet.has(lastSelectedRowIdRef.current)) {
            lastSelectedRowIdRef.current = null;
        }
    }, [visibleRowIdKey]);

    useEffect(() => {
        if (!visibilityPanelOpen) {
            return;
        }
        function closeOnOutside(event: MouseEvent): void {
            const target = event.target as Node;
            const targetElement = target instanceof Element ? target : null;
            const insideCategoryPortal = Boolean(targetElement?.closest(".nordea-category-options"));
            if (!visibilityPanelRef.current?.contains(target) && !visibilityButtonRef.current?.contains(target) && !insideCategoryPortal) {
                setVisibilityPanelOpen(false);
            }
        }
        document.addEventListener("mousedown", closeOnOutside);
        return () => document.removeEventListener("mousedown", closeOnOutside);
    }, [visibilityPanelOpen]);

    useEffect(() => {
        if (page > pageCount) {
            setPage(pageCount);
        }
    }, [page, pageCount]);

    useEffect(() => {
        if (!selectedTransaction) {
            setDateText("");
            setIsExtraordinary(false);
            return;
        }
        setDateText(selectedTransaction.booking_date ?? "");
        setIsExtraordinary(selectedTransaction.is_extraordinary);
    }, [selectedRow?.rowId, selectedTransaction?.id]);

    useEffect(() => {
        if (expandedMobileRowId && !mobileTransactions.some((row) => row.rowId === expandedMobileRowId)) {
            setExpandedMobileRowId(null);
        }
    }, [expandedMobileRowId, mobileTransactions]);

    useLayoutEffect(() => {
        const tableContainer = tableContainerRef.current;
        const editPanel = editPanelRef.current;
        if (!tableContainer || !editPanel || selectedIds.length === 0) {
            setEditPanelTop(0);
            return;
        }
        const table = tableContainer.querySelector("table");
        const tableHead = tableContainer.querySelector("thead");
        const selectedRows = Array.from(tableContainer.querySelectorAll<HTMLTableRowElement>("tbody tr.nordea-selected-row"));
        if (!table || selectedRows.length === 0) {
            setEditPanelTop(0);
            return;
        }
        const tableRect = table.getBoundingClientRect();
        const firstRowRect = selectedRows[0].getBoundingClientRect();
        const lastRowRect = selectedRows[selectedRows.length - 1].getBoundingClientRect();
        const headerHeight = tableHead?.getBoundingClientRect().height ?? 31;
        const panelHeight = editPanel.getBoundingClientRect().height;
        const maxTop = Math.max(headerHeight, tableRect.height - panelHeight);
        const rowTop = firstRowRect.top - tableRect.top;
        const rowBottom = lastRowRect.bottom - tableRect.top;
        const desiredTop = selectedRows.length === 1 ? rowTop + (firstRowRect.height / 2) - (panelHeight / 2) : rowTop;
        const nextTop = Math.round(Math.min(Math.max(desiredTop, headerHeight), Math.max(maxTop, rowBottom - panelHeight)));
        setEditPanelTop((current) => current === nextTop ? current : nextTop);
    }, [selectedIds, selectedTransaction?.id, visibleTransactions]);

    function visibleRangeToRow(rowId: string): string[] | null {
        const anchorId = lastSelectedRowIdRef.current;
        if (!anchorId || !visibleRowIdSet.has(anchorId)) {
            return null;
        }
        const anchorIndex = visibleRowIds.indexOf(anchorId);
        const rowIndex = visibleRowIds.indexOf(rowId);
        if (anchorIndex === -1 || rowIndex === -1) {
            return null;
        }
        const [start, end] = anchorIndex < rowIndex ? [anchorIndex, rowIndex] : [rowIndex, anchorIndex];
        return visibleRowIds.slice(start, end + 1);
    }

    function selectRow(rowId: string, modifiers?: { metaKey?: boolean; shiftKey?: boolean }): void {
        setSelectedIds((current) => {
            if (modifiers?.shiftKey) {
                keyboardSelectionStartRef.current = null;
                keyboardSelectionEndRef.current = null;
                return visibleRangeToRow(rowId) ?? [rowId];
            }
            if (modifiers?.metaKey) {
                keyboardSelectionStartRef.current = null;
                keyboardSelectionEndRef.current = null;
                return current.includes(rowId) ? current.filter((id) => id !== rowId) : [...current, rowId];
            }
            const rowIndex = visibleRowIds.indexOf(rowId);
            keyboardSelectionStartRef.current = rowIndex >= 0 ? rowIndex : null;
            keyboardSelectionEndRef.current = null;
            return [rowId];
        });
        lastSelectedRowIdRef.current = rowId;
    }

    function scrollVisibleRowIntoView(rowId: string): void {
        window.requestAnimationFrame(() => {
            const rows = Array.from(tableContainerRef.current?.querySelectorAll<HTMLTableRowElement>("tbody tr") ?? []);
            rows.find((row) => row.dataset.rowId === rowId)?.scrollIntoView({ block: "nearest" });
        });
    }

    function selectVisibleRowAtIndex(rowIndex: number): void {
        const rowId = visibleRowIds[rowIndex];
        if (!rowId) {
            return;
        }
        setSelectedIds([rowId]);
        lastSelectedRowIdRef.current = rowId;
        keyboardSelectionStartRef.current = rowIndex;
        keyboardSelectionEndRef.current = null;
        scrollVisibleRowIntoView(rowId);
    }

    function selectVisibleKeyboardRange(direction: "up" | "down"): void {
        const selectedIndexes = selectedIds
            .map((rowId) => visibleRowIds.indexOf(rowId))
            .filter((rowIndex) => rowIndex >= 0)
            .sort((left, right) => left - right);
        if (selectedIndexes.length === 0) {
            return;
        }
        const startIndex = keyboardSelectionStartRef.current ?? selectedIndexes[0];
        const currentEndIndex = keyboardSelectionEndRef.current ?? startIndex;
        const nextEndIndex = direction === "up" ? currentEndIndex - 1 : currentEndIndex + 1;
        if (nextEndIndex < 0 || nextEndIndex >= visibleRowIds.length) {
            return;
        }
        const [start, end] = startIndex < nextEndIndex ? [startIndex, nextEndIndex] : [nextEndIndex, startIndex];
        const nextIds = visibleRowIds.slice(start, end + 1);
        setSelectedIds(nextIds);
        lastSelectedRowIdRef.current = visibleRowIds[nextEndIndex] ?? null;
        keyboardSelectionStartRef.current = startIndex;
        keyboardSelectionEndRef.current = nextEndIndex;
        if (lastSelectedRowIdRef.current) {
            scrollVisibleRowIntoView(lastSelectedRowIdRef.current);
        }
    }

    function selectAllVisibleRows(): void {
        if (visibleRowIds.length === 0) {
            return;
        }
        setSelectedIds(visibleRowIds);
        lastSelectedRowIdRef.current = visibleRowIds[0] ?? null;
        keyboardSelectionStartRef.current = 0;
        keyboardSelectionEndRef.current = visibleRowIds.length - 1;
        scrollVisibleRowIntoView(visibleRowIds[0]);
    }

    function selectNextVisibleRow(rowId: string): void {
        const rowIndex = visibleRowIds.indexOf(rowId);
        const nextRowId = rowIndex >= 0 ? visibleRowIds[rowIndex + 1] : null;
        if (!nextRowId) {
            return;
        }
        setSelectedIds([nextRowId]);
        lastSelectedRowIdRef.current = nextRowId;
        keyboardSelectionStartRef.current = rowIndex + 1;
        keyboardSelectionEndRef.current = null;
        scrollVisibleRowIntoView(nextRowId);
    }

    function toggleSelected(rowId: string, checked: boolean, shiftKey: boolean): void {
        setSelectedIds((current) => {
            if (shiftKey) {
                const rangeIds = visibleRangeToRow(rowId);
                if (rangeIds) {
                    if (checked) {
                        return rangeIds;
                    }
                    const rangeIdSet = new Set(rangeIds);
                    return current.filter((id) => !rangeIdSet.has(id));
                }
            }
            if (checked) {
                return current.includes(rowId) ? current : [...current, rowId];
            }
            return current.filter((id) => id !== rowId);
        });
        lastSelectedRowIdRef.current = rowId;
        keyboardSelectionStartRef.current = visibleRowIds.indexOf(rowId);
        keyboardSelectionEndRef.current = null;
    }

    useEffect(() => {
        if (!active || isMobileLayout) {
            return undefined;
        }

        function shouldIgnoreKeyboardTarget(target: EventTarget | null): boolean {
            if (!(target instanceof Element)) {
                return false;
            }
            if (target.closest(".nordea-category-picker")) {
                return false;
            }
            if (target instanceof HTMLInputElement && target.type === "checkbox" && target.closest(".nordea-posting-table-container")) {
                return false;
            }
            const isEditable = target instanceof HTMLInputElement
                || target instanceof HTMLTextAreaElement
                || target instanceof HTMLSelectElement
                || target.hasAttribute("contenteditable");
            return isEditable;
        }

        function goUpOrDown(direction: "up" | "down"): void {
            const selectedIndexes = selectedIds
                .map((rowId) => visibleRowIds.indexOf(rowId))
                .filter((rowIndex) => rowIndex >= 0)
                .sort((left, right) => left - right);
            const baseIndex = selectedIndexes.length > 1
                ? direction === "up" ? selectedIndexes[0] : selectedIndexes[selectedIndexes.length - 1]
                : selectedIndexes[0] ?? (direction === "up" ? visibleRowIds.length : -1);
            const nextIndex = direction === "up" ? baseIndex - 1 : baseIndex + 1;
            if (nextIndex >= 0 && nextIndex < visibleRowIds.length) {
                selectVisibleRowAtIndex(nextIndex);
            }
        }

        function handleDocumentKeyDown(event: KeyboardEvent): void {
            if (event.defaultPrevented) {
                return;
            }
            const isMacCommand = navigator.platform.includes("Mac") ? event.metaKey && !event.ctrlKey : event.ctrlKey;
            if (event.key === "Escape") {
                if (visibilityPanelOpen) {
                    event.preventDefault();
                    setVisibilityPanelOpen(false);
                }
                if (splitModalOpen) {
                    event.preventDefault();
                    setSplitModalOpen(false);
                }
                if (sunburstDrilldownModal) {
                    event.preventDefault();
                    setSunburstDrilldownModal(null);
                }
                return;
            }
            if (shouldIgnoreKeyboardTarget(event.target)) {
                return;
            }
            if (event.key === "Enter") {
                event.preventDefault();
                goUpOrDown("down");
                return;
            }
            if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                event.preventDefault();
                const direction = event.key === "ArrowUp" ? "up" : "down";
                if (event.shiftKey) {
                    selectVisibleKeyboardRange(direction);
                    return;
                }
                goUpOrDown(direction);
                return;
            }
            if (event.key.toLowerCase() === "a" && isMacCommand) {
                event.preventDefault();
                selectAllVisibleRows();
            }
        }

        document.addEventListener("keydown", handleDocumentKeyDown);
        return () => document.removeEventListener("keydown", handleDocumentKeyDown);
    }, [active, isMobileLayout, selectedIds, splitModalOpen, sunburstDrilldownModal, visibilityPanelOpen, visibleRowIds]);

    function transactionWithCategory(transaction: NordeaTransaction, category: NordeaCategoryOption): NordeaTransaction {
        return {
            ...transaction,
            categoryType: category.categoryType,
            mainCategoryId: category.mainCategoryId,
            mainCategoryName: category.mainCategoryName,
            categoryId: category.categoryId,
            categoryName: category.categoryName,
        };
    }

    function transactionWithHashtag(transaction: NordeaTransaction, hashtag: string, checked: boolean): NordeaTransaction {
        const normalizedTag = normalizeHashtag(hashtag);
        if (!normalizedTag) {
            return transaction;
        }
        const currentTags = (transaction.hashtags ?? []).map(normalizeHashtag).filter(Boolean);
        const nextStoredTags = checked
            ? [...new Set([...currentTags, normalizedTag])]
            : currentTags.filter((tag) => tag !== normalizedTag);
        const note = transaction.note ?? "";
        const nextNote = checked ? noteWithHashtags(note, [normalizedTag]) : noteWithoutHashtags(note, [normalizedTag]);
        const splits = transaction.splits ?? [];
        const nextSplits = splits.map((split) => ({
            ...split,
            note: checked
                ? splits.length === 1 ? noteWithHashtags(split.note ?? "", [normalizedTag]) : split.note
                : noteWithoutHashtags(split.note ?? "", [normalizedTag]),
        }));
        const nextHashtags = [...new Set([
            ...nextStoredTags,
            ...extractedHashtags(nextNote),
            ...nextSplits.flatMap((split) => extractedHashtags(split.note)),
        ])];
        return {
            ...transaction,
            note: nextNote,
            hashtags: nextHashtags,
            splits: nextSplits,
        };
    }

    function saveBulkCategory(category: NordeaCategoryOption): void {
        const parentIds = selectedParentIds;
        const parentIdSet = new Set(parentIds);
        setData((current) => {
            if (current === null) {
                return current;
            }
            return {
                ...current,
                transactions: current.transactions.map((transaction) => parentIdSet.has(transaction.id) ? transactionWithCategory(transaction, category) : transaction),
            };
        });
        void savePatch(parentIds, { category });
    }

    function initialSplitCategory(transaction: NordeaTransaction): NordeaCategoryOption | null {
        const category = categoryFromTransaction(transaction);
        return isUncategorizedCategory(category) ? null : category;
    }

    function splitRowsForTransaction(transaction: NordeaTransaction): NordeaTransaction[] {
        const groupId = transaction.split_group_id?.trim();
        if (!groupId) {
            return [transaction];
        }
        const groupRows = transactions
            .filter((item) => item.split_group_id === groupId)
            .sort((left, right) => {
                const [leftIndex, leftId] = splitLineSortKey(left);
                const [rightIndex, rightId] = splitLineSortKey(right);
                return leftIndex === rightIndex ? leftId.localeCompare(rightId) : leftIndex - rightIndex;
            });
        return groupRows.length > 0 ? groupRows : [transaction];
    }

    function splitTotalAmount(transaction: NordeaTransaction): number {
        return splitRowsForTransaction(transaction).reduce((total, item) => total + item.amount, 0);
    }

    function splitDisplayMultiplier(transaction: NordeaTransaction): number {
        return splitTotalAmount(transaction) >= 0 ? 1 : -1;
    }

    function recalculateSplitLines(lines: SplitDraftLine[], parentAmount: number): SplitDraftLine[] {
        if (lines.length === 0) {
            return lines;
        }
        const restAmount = lines.slice(1).reduce((sum, line) => sum + (Number.isFinite(line.amount) ? line.amount : 0), 0);
        return lines.map((line, index) => {
            if (index !== 0) {
                return { ...line, locked: false };
            }
            const amount = roundAmount(parentAmount - restAmount);
            return { ...line, amount, amountText: formatSplitDraftAmount(amount), locked: true };
        });
    }

    function blankSplitLine(): SplitDraftLine {
        return {
            id: `split-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            amount: 0,
            amountText: formatSplitDraftAmount(0),
            note: "",
            category: null,
            locked: false,
        };
    }

    function setSplitDraftLines(updater: (current: SplitDraftLine[]) => SplitDraftLine[]): void {
        if (!selectedTransaction) {
            return;
        }
        const parentAmount = Math.abs(splitTotalAmount(selectedTransaction));
        setSplitError(null);
        setSplitLines((current) => recalculateSplitLines(updater(current), parentAmount));
    }

    async function saveSplitLines(): Promise<void> {
        if (!selectedTransaction) {
            return;
        }
        const invalidCategory = splitLines.some((line) => !line.category);
        if (invalidCategory) {
            setSplitError("Vælg venligst kategori for alle splits.");
            return;
        }
        const invalidAmount = splitLines.some((line) => !Number.isFinite(line.amount) || Math.abs(line.amount) < 0.005);
        if (invalidAmount) {
            setSplitError("Indtast venligst et beløb for alle splits.");
            return;
        }
        const multiplier = splitDisplayMultiplier(selectedTransaction);
        const payload: NordeaSplitLine[] = splitLines.map((line) => ({
            id: line.id,
            amount: roundAmount(line.amount * multiplier),
            note: line.note,
            category: line.category!,
        }));
        if (payload.length <= 1) {
            const singleSplit = payload[0];
            const saved = await savePatch([selectedTransaction.id], {
                splits: [],
                ...(singleSplit ? { category: singleSplit.category, note: singleSplit.note } : {}),
            });
            if (saved) {
                setSplitModalOpen(false);
            }
            return;
        }
        const saved = await savePatch([selectedTransaction.id], { splits: payload });
        if (saved) {
            setSplitModalOpen(false);
        }
    }

    function saveRowCategory(row: NordeaDisplayRow, category: NordeaCategoryOption, selectNext = false): void {
        if (row.isSplitChild && row.splitIndex !== null && hasEmbeddedSplit(row.transaction)) {
            const nextSplits = (row.transaction.splits ?? []).map((split, index) => index === row.splitIndex ? { ...split, category } : split);
            setData((current) => {
                if (current === null) {
                    return current;
                }
                return {
                    ...current,
                    transactions: current.transactions.map((transaction) =>
                        transaction.id === row.parentId
                            ? { ...transaction, splits: nextSplits }
                            : transaction
                    ),
                };
            });
            void savePatch([row.parentId], { splits: nextSplits });
            if (selectNext) {
                selectNextVisibleRow(row.rowId);
            }
            return;
        }

        setData((current) => {
            if (current === null) {
                return current;
            }
            return {
                ...current,
                transactions: current.transactions.map((transaction) =>
                    transaction.id === row.parentId
                        ? transactionWithCategory(transaction, category)
                        : transaction
                ),
            };
        });
        void savePatch([row.parentId], { category });
        if (selectNext) {
            selectNextVisibleRow(row.rowId);
        }
    }

    function saveRowNote(row: NordeaDisplayRow, note: string): void {
        const nextHashtags = extractedHashtags(note);
        if (row.isSplitChild && row.splitIndex !== null && hasEmbeddedSplit(row.transaction)) {
            const nextSplits = (row.transaction.splits ?? []).map((split, index) => index === row.splitIndex ? { ...split, note } : split);
            setData((current) => {
                if (current === null) {
                    return current;
                }
                return {
                    ...current,
                    transactions: current.transactions.map((transaction) =>
                        transaction.id === row.parentId
                            ? { ...transaction, splits: nextSplits }
                            : transaction
                    ),
                };
            });
            void savePatch([row.parentId], { splits: nextSplits });
            return;
        }

        setData((current) => {
            if (current === null) {
                return current;
            }
            return {
                ...current,
                transactions: current.transactions.map((transaction) =>
                    transaction.id === row.parentId
                        ? { ...transaction, note, hashtags: nextHashtags }
                        : transaction
                ),
            };
        });
        void savePatch([row.parentId], { note });
    }

    function openMobileRow(row: NordeaDisplayRow, focusCategoryInput = false): void {
        let opening = false;
        flushSync(() => {
            setExpandedMobileRowId((current) => {
                opening = current !== row.rowId;
                return opening ? row.rowId : null;
            });
        });
        if (!opening || !focusCategoryInput) {
            return;
        }
        const input = document.getElementById(`nordea-mobile-row-${row.rowId}`)?.querySelector<HTMLInputElement>(".nordea-category-picker input");
        input?.focus();
        input?.select();
    }

    function closeMobileRow(row: NordeaDisplayRow, note: string): void {
        if (note !== row.note) {
            saveRowNote(row, note);
        }
        setExpandedMobileRowId(null);
    }

    function openMobileSplit(row: NordeaDisplayRow): void {
        setSelectedIds([row.rowId]);
        lastSelectedRowIdRef.current = row.rowId;
        setExpandedMobileRowId(row.rowId);
        openSplitModal(row.transaction);
    }

    function handleSort(nextSortKey: SortKey): void {
        setPage(1);
        if (nextSortKey === sortKey) {
            setSortDirection((current) => current === "asc" ? "desc" : "asc");
            return;
        }
        setSortKey(nextSortKey);
        setSortDirection(nextSortKey === "booking_date" || nextSortKey === "amount" ? "desc" : "asc");
    }

    function openSplitModal(transaction: NordeaTransaction): void {
        const groupRows = splitRowsForTransaction(transaction);
        const parentAmount = Math.abs(splitTotalAmount(transaction));
        const multiplier = splitDisplayMultiplier(transaction);
        const canonicalLines = transaction.split_group_id && groupRows.length > 1
            ? groupRows.map((row, index) => ({
                id: row.id,
                amount: roundAmount(row.amount * multiplier),
                amountText: formatSplitDraftAmount(roundAmount(row.amount * multiplier)),
                note: row.note ?? "",
                category: categoryFromTransaction(row),
                locked: index === 0,
            }))
            : [];
        const embeddedLines = canonicalLines.length === 0 ? (transaction.splits ?? []).map((split, index) => ({
            id: split.id,
            amount: roundAmount(split.amount * multiplier),
            amountText: formatSplitDraftAmount(roundAmount(split.amount * multiplier)),
            note: split.note,
            category: split.category,
            locked: index === 0,
        })) : [];
        const existingLines = canonicalLines.length > 0 ? canonicalLines : embeddedLines;
        const baseLines = existingLines.length === 0
            ? [{ id: `split-${transaction.id}-0`, amount: parentAmount, amountText: formatSplitDraftAmount(parentAmount), note: transaction.note ?? "", category: initialSplitCategory(transaction), locked: true }]
            : existingLines;
        const nextLines = baseLines.length <= 1 ? [...baseLines, blankSplitLine()] : baseLines;
        setSplitError(null);
        setSplitLines(recalculateSplitLines(nextLines, parentAmount));
        setSplitModalOpen(true);
    }

    async function openIncomeExpenseSunburst(month: string): Promise<void> {
        try {
            const overview = spiirOverview ?? await getSpiirOverview();
            if (!spiirOverview) {
                setSpiirOverview(overview);
            }
            setSunburstState({
                title: `Månedsoversigt · ${longMonthLabel(month)}`,
                mode: "months",
                periods: [month],
                rows: overview.monthly.rows
            });
        } catch (loadError) {
            setError(loadError instanceof Error ? loadError.message : "Kunne ikke åbne Spiir sunburst");
        }
    }

    async function ensureSpiirTransactionsLoaded(): Promise<SpiirTransaction[]> {
        if (spiirTransactions) {
            return spiirTransactions;
        }
        const loaded = await getSpiirTransactions();
        setSpiirTransactions(loaded);
        return loaded;
    }

    function openSunburstDrilldown(title: string, items: SpiirTransaction[]): void {
        const categoryFilter = categoryOptionFromSpiirTransactions(items);
        setSunburstDrilldownModal({
            title,
            periodFilter: periodFilterFromSpiirTransactions(items),
            visibilityFilter: categoryFilter ? "category" : "all",
            categoryFilter,
            searchText: items.length === 1 ? String(items[0].description ?? "") : "",
        });
    }

    const allVisibleSelected = visibleTransactions.length > 0 && visibleTransactions.every((row) => selectedIds.includes(row.rowId));
    const splitSaveDisabled = saving || splitLines.length === 0 || splitLines.some((line) => !line.category || !Number.isFinite(line.amount) || Math.abs(line.amount) < 0.005);
    const visibilityButtonLabel = visibilityLabel(visibilityFilter, categoryFilter?.categoryName ?? "");
    const spiirNeedsRebuild = Boolean(isLocalLedgerSource && spiirStatus?.rebuild_required);

    return (
        <section className={embedded ? "nordea-poster nordea-poster-embedded" : "nordea-poster"}>
            {embedded ? (
                <header className="nordea-embedded-header">
                    <div>
                        <p className="eyebrow">Nordea</p>
                        <h2>{initialFilter?.title ?? "Poster"}</h2>
                    </div>
                    {onClose ? <button type="button" className="secondary-button" onClick={onClose}>Luk</button> : null}
                </header>
            ) : null}
            {!isLocalLedgerSource ? (
                <header className="nordea-poster-header">
                    <div>
                        <h2>Nordea</h2>
                        <span>{data?.last_retrieved_at ? `Senest hentet ${formatDateTime(data.last_retrieved_at)}` : "Rå transaktioner fra Enable Banking"}</span>
                    </div>
                </header>
            ) : null}
            {error ? <p className="error-banner">{error}</p> : null}
            {retrievePanelOpen ? (
                <section className="nordea-retrieve-panel" aria-live="polite">
                    <p className="nordea-retrieve-panel-title">
                        {retrieveChecking
                            ? "Tjekker om hentning blev færdig i baggrunden..."
                            : retrieveJobStatus?.current_phase || "Henter seneste transaktioner fra Nordea..."}
                    </p>
                    <div className="nordea-retrieve-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={retrieveProgress}>
                        <span className="nordea-retrieve-progress-fill" style={{ width: `${retrieveProgress}%` }} />
                    </div>
                    <p className="nordea-retrieve-panel-meta">
                        Forventet tid: ca. {Math.round(retrieveExpectedMs / 1000)} sek
                        {data?.last_retrieve_duration_seconds ? ` (sidst ${Math.round(data.last_retrieve_duration_seconds)} sek)` : ""}
                    </p>
                </section>
            ) : null}
            {notice ? <p className="info-banner">{notice}</p> : null}
            {isLocalLedgerSource && !embedded ? <IncomeExpenseOverview series={incomeExpenseSeries} onOpenSunburst={(month) => void openIncomeExpenseSunburst(month)} /> : null}
            <section className="nordea-poster-controls">
                <div className="nordea-filter-bar">
                    <div className="nordea-spiir-filter-shell">
                        <div className="nordea-spiir-filter-strip">
                            <span>Viser</span>
                            <button
                                type="button"
                                className="nordea-spiir-filter-button"
                                ref={visibilityButtonRef}
                                onClick={() => setVisibilityPanelOpen((current) => !current)}
                            >
                                {visibilityButtonLabel} <span aria-hidden="true">▼</span>
                            </button>
                            <span>fra</span>
                            <select
                                className="nordea-spiir-filter-select"
                                value={periodFilter}
                                onChange={(event) => {
                                    setPeriodFilter(event.target.value as PeriodFilter);
                                    setCustomPeriodStart("");
                                    setCustomPeriodEnd("");
                                }}
                            >
                                <option value="all">hele perioden</option>
                                {periodFilter === "custom" ? <option value="custom">Custom</option> : null}
                                <optgroup label="År">
                                    {periodOptions.years.map((year) => (
                                        <option key={year} value={`year:${year}`}>{year}</option>
                                    ))}
                                </optgroup>
                                <optgroup label="Måneder">
                                    {periodOptions.months.map((month) => (
                                        <option key={month} value={`month:${month}`}>{monthLabel(month)}</option>
                                    ))}
                                </optgroup>
                            </select>
                            <span>med teksten</span>
                            <div className="nordea-spiir-search-wrap">
                                <SearchField value={searchText} resetKey={searchResetKey} onCommit={setSearchText} onClear={resetSearchToLatest} />
                            </div>
                            <div className="nordea-spiir-filter-actions">
                                {isLocalLedgerSource && saving ? (
                                    <span className="nordea-save-indicator" aria-live="polite">
                                        <span className="nordea-saving-spinner" aria-hidden="true" />
                                        Gemmer
                                    </span>
                                ) : null}
                                {isLocalLedgerSource ? (
                                    <button
                                        type="button"
                                        onClick={() => void handleBuildSpiir()}
                                        disabled={retrieving || retrieveChecking || saving || buildingSpiir || !spiirNeedsRebuild}
                                    >
                                        {buildingSpiir ? "Bygger..." : "Byg Spiir"}
                                    </button>
                                ) : null}
                                <button
                                    type="button"
                                    onClick={() => void (isLocalLedgerSource && pendingReviewCount > 0 ? handleAcknowledgePending() : handleRetrieve())}
                                    disabled={retrieving || retrieveChecking || saving || buildingSpiir}
                                >
                                    {saving && isLocalLedgerSource && pendingReviewCount > 0
                                        ? "Gemmer..."
                                        : retrieving
                                            ? "Henter..."
                                            : retrieveChecking
                                                ? "Tjekker status..."
                                                : isLocalLedgerSource
                                                    ? pendingReviewCount > 0
                                                        ? "Marker gennemgået"
                                                        : "Hent"
                                                    : "Hent seneste"}
                                </button>
                            </div>
                            <button
                                type="button"
                                className="nordea-spiir-reset-link"
                                onClick={() => {
                                    setVisibilityFilter("all");
                                    setCategoryFilter(null);
                                    setPeriodFilter("all");
                                    setCustomPeriodStart("");
                                    setCustomPeriodEnd("");
                                    resetSearchToLatest();
                                    setPage(1);
                                }}
                                disabled={visibilityFilter === "all" && !categoryFilter && periodFilter === "all" && !searchText}
                            >
                                Nulstil filtre
                            </button>
                        </div>

                        {visibilityPanelOpen ? (
                            <div className="nordea-spiir-visibility-panel" ref={visibilityPanelRef}>
                                <h3>Vis</h3>
                                <label className="nordea-spiir-radio-row">
                                    <input type="radio" checked={visibilityFilter === "all"} onChange={() => setVisibilityFilter("all")} />
                                    <span>Alle poster</span>
                                </label>
                                <label className="nordea-spiir-radio-row">
                                    <input type="radio" checked={visibilityFilter === "bills"} onChange={() => setVisibilityFilter("bills")} />
                                    <span>Alle regninger</span>
                                </label>
                                <label className="nordea-spiir-radio-row">
                                    <input type="radio" checked={visibilityFilter === "consumption"} onChange={() => setVisibilityFilter("consumption")} />
                                    <span>Alt forbrug</span>
                                </label>
                                <div className="nordea-spiir-radio-row nordea-spiir-category-row">
                                    <input
                                        type="radio"
                                        checked={visibilityFilter === "category"}
                                        onChange={() => setVisibilityFilter("category")}
                                    />
                                    <CategorySelect
                                        categories={taxonomy.categories}
                                        value={categoryFilter ? categoryKey(categoryFilter) : ""}
                                        onChange={(category) => {
                                            if (category) {
                                                setCategoryFilter(category);
                                                setVisibilityFilter("category");
                                            }
                                        }}
                                        allowMainSelection
                                        placeholder="Vælg kategori"
                                    />
                                </div>
                                <label className="nordea-spiir-radio-row">
                                    <input type="radio" checked={visibilityFilter === "uncategorized"} onChange={() => setVisibilityFilter("uncategorized")} />
                                    <span>Ikke kategoriserede poster</span>
                                </label>
                                <label className="nordea-spiir-radio-row">
                                    <input type="radio" checked={visibilityFilter === "extraordinary"} onChange={() => setVisibilityFilter("extraordinary")} />
                                    <span>Ekstraordinære poster</span>
                                </label>
                                <div className="nordea-spiir-visibility-footer">
                                    <label>
                                        <input
                                            type="checkbox"
                                            checked={showTransfersAlways}
                                            disabled={visibilityFilter !== "all"}
                                            onChange={(event) => setShowTransfersAlways(event.target.checked)}
                                        />
                                        <span>Vis altid kontooverførsler, udlæg og ignorer</span>
                                    </label>
                                    <button type="button" className="nordea-spiir-close-link" onClick={() => setVisibilityPanelOpen(false)}>
                                        Luk
                                    </button>
                                </div>
                            </div>
                        ) : null}
                    </div>
                </div>
                <div className="nordea-poster-stats">
                    <div>
                        <span>Viser</span>
                        <strong>{loading ? "..." : `${filteredTransactions.length} af ${displayTransactions.length}`}</strong>
                    </div>
                    <div>
                        <span>I alt</span>
                        <strong>{formatDkk(totals.amount)}</strong>
                    </div>
                    <div>
                        <span>Gns.</span>
                        <strong>{formatDkk(totals.average)}</strong>
                    </div>
                </div>
                {isMobileLayout ? (
                    <div className="nordea-mobile-review-bar">
                        <button type="button" className={!mobilePendingOnly ? "active" : ""} onClick={() => setMobilePendingOnly(false)}>
                            Seneste
                        </button>
                        <button type="button" className={mobilePendingOnly ? "active" : ""} onClick={() => setMobilePendingOnly(true)}>
                            Pending {pendingReviewCount > 0 ? pendingReviewCount : ""}
                        </button>
                    </div>
                ) : null}
                {!isMobileLayout ? <div className="nordea-pagination-bar">
                    <span>{filteredTransactions.length === 0 ? "0 poster" : `${firstVisible}-${lastVisible} af ${filteredTransactions.length}`}</span>
                    <div>
                        {isLocalLedgerSource && !allTransactionsLoaded ? (
                            <button
                                type="button"
                                className="secondary-button"
                                onClick={() => void handleLoadMoreTransactions()}
                                disabled={loadingMore || loading || saving || retrieving || retrieveChecking}
                            >
                                {loadingMore ? "Henter flere..." : "Hent ældre"}
                            </button>
                        ) : null}
                        <button type="button" className="secondary-button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page <= 1}>
                            Forrige
                        </button>
                        <span>Side {page} / {pageCount}</span>
                        <button type="button" className="secondary-button" onClick={() => setPage((current) => Math.min(pageCount, current + 1))} disabled={page >= pageCount}>
                            Næste
                        </button>
                    </div>
                </div> : null}
            </section>
            {isMobileLayout ? <section className="nordea-mobile-review-list" aria-label="Nordea poster">
                {visibleMobileTransactions.map((row) => {
                    const expanded = expandedMobileRowId === row.rowId;
                    return (
                        <MobileReviewRow
                            key={row.rowId}
                            row={row}
                            expanded={expanded}
                            categories={taxonomy.categories}
                            hashtags={taxonomy.hashtags}
                            editControlsDisabled={editControlsDisabled}
                            onOpen={openMobileRow}
                            onClose={closeMobileRow}
                            onCategoryChange={(targetRow, category) => saveRowCategory(targetRow, category, false)}
                            onSplit={openMobileSplit}
                        />
                    );
                })}
                {!loading && mobileTransactions.length === 0 ? <p className="nordea-mobile-empty">Ingen Nordea-poster matcher filteret.</p> : null}
                {mobileRenderLimit < mobileTransactions.length ? (
                    <div className="nordea-mobile-load-more-sentinel" ref={mobileLoadMoreRef}>
                        <button
                            type="button"
                            className="nordea-mobile-load-more"
                            onClick={() => setMobileRenderLimit((current) => Math.min(current + MOBILE_RENDER_INCREMENT, mobileTransactions.length))}
                        >
                            Vis flere
                        </button>
                    </div>
                ) : null}
                {isLocalLedgerSource && !allTransactionsLoaded ? (
                    <button
                        type="button"
                        className="nordea-mobile-load-more"
                        onClick={() => void handleLoadMoreTransactions()}
                        disabled={loadingMore || loading || saving || retrieving || retrieveChecking}
                    >
                        {loadingMore ? "Henter flere..." : "Hent ældre"}
                    </button>
                ) : null}
            </section> : null}
            {!isMobileLayout ? <section className="nordea-poster-content">
                <div className="nordea-posting-table-container" ref={tableContainerRef}>
                    <table className="nordea-table">
                        <colgroup>
                            <col className="nordea-checkbox-column" />
                            <col className="nordea-date-column" />
                            <col className="nordea-description-column" />
                            <col className="nordea-category-column" />
                            <col className="nordea-icon-column" />
                            <col className="nordea-icon-column" />
                            <col className="nordea-amount-column" />
                        </colgroup>
                        <thead>
                            <tr>
                                <th className="nordea-checkbox-cell">
                                    <input
                                        type="checkbox"
                                        checked={allVisibleSelected}
                                        onClick={(event) => event.stopPropagation()}
                                        onChange={() => {
                                            if (allVisibleSelected) {
                                                setSelectedIds([]);
                                                lastSelectedRowIdRef.current = null;
                                            } else {
                                                setSelectedIds(visibleRowIds);
                                                lastSelectedRowIdRef.current = visibleRowIds[0] ?? null;
                                            }
                                        }}
                                    />
                                </th>
                                <th className="nordea-date-cell"><SortHeader label="Dato" sortKey="booking_date" activeSortKey={sortKey} direction={sortDirection} onSort={handleSort} /></th>
                                <th><SortHeader label="Beskrivelse" sortKey="description" activeSortKey={sortKey} direction={sortDirection} onSort={handleSort} /></th>
                                <th><SortHeader label="Kategori" sortKey="category" activeSortKey={sortKey} direction={sortDirection} onSort={handleSort} /></th>
                                <th className="nordea-icon-cell" />
                                <th className="nordea-icon-cell" />
                                <th><SortHeader label="Beløb" sortKey="amount" activeSortKey={sortKey} direction={sortDirection} onSort={handleSort} /></th>
                            </tr>
                        </thead>
                        <tbody>
                            {visibleTransactions.map((row) => {
                                const subtitle = counterparty(row.transaction);
                                const selected = selectedIds.includes(row.rowId);
                                const note = row.note.trim();
                                return (
                                    <tr
                                        key={row.rowId}
                                        data-row-id={row.rowId}
                                        title={detailTitle(row.transaction)}
                                        className={nordeaRowClassName(row, selected, selectedIds.length)}
                                        onClick={(event) => {
                                            if (event.metaKey || event.shiftKey) {
                                                event.preventDefault();
                                            }
                                            selectRow(row.rowId, { metaKey: event.metaKey, shiftKey: event.shiftKey });
                                        }}
                                    >
                                        <td className="nordea-checkbox-cell" onClick={(event) => event.stopPropagation()}>
                                            <input type="checkbox" checked={selected} onChange={(event) => toggleSelected(row.rowId, event.target.checked, (event.nativeEvent as MouseEvent).shiftKey)} />
                                        </td>
                                        <td className="nordea-date-cell">{formatTxDate(row.transaction.booking_date)}</td>
                                        <td className="nordea-description-cell">
                                            <span>{row.transaction.description}</span>
                                            {note ? <span className="nordea-description-note"> ({note})</span> : null}
                                            {isPendingReview(row.transaction) ? <span className="nordea-pending-pill">Pending</span> : null}
                                        </td>
                                        <td className="nordea-category-cell" onClick={selected ? (event) => event.stopPropagation() : undefined}>
                                            <div className="nordea-category-wrapper">
                                                {selected && selectedIds.length === 1 && taxonomy.categories.length > 0 ? (
                                                    <CategorySelect
                                                        categories={taxonomy.categories}
                                                        value={isUncategorizedCategory(row.category) ? "" : categoryKey(row.category)}
                                                        onChange={(category) => category ? saveRowCategory(row, category, true) : undefined}
                                                        disabled={editControlsDisabled}
                                                        placeholder="Skriv fx bluse"
                                                        autoFocus
                                                        selectValueOnFocus
                                                        openOnFocus={false}
                                                        bubbleClosedTableKeys
                                                    />
                                                ) : (
                                                    <span className="nordea-category-text">{isUncategorizedCategory(row.category) ? "" : categoryLabelForRow(row)}</span>
                                                )}
                                            </div>
                                        </td>
                                        <td className="nordea-icon-cell">{row.isSplitChild ? <span>S</span> : null}</td>
                                        <td className="nordea-icon-cell">{row.transaction.is_extraordinary ? <span>E</span> : null}</td>
                                        <td className={row.amount < 0 ? "spiir-negative nordea-amount-cell" : row.amount > 0 ? "spiir-positive nordea-amount-cell" : "spiir-neutral nordea-amount-cell"}>
                                            {formatPostingAmount(row.amount)}
                                        </td>
                                    </tr>
                                );
                            })}
                            {!loading && filteredTransactions.length === 0 ? (
                                <tr>
                                    <td colSpan={7}>Ingen Nordea-transaktioner matcher filteret.</td>
                                </tr>
                            ) : null}
                        </tbody>
                    </table>
                </div>

                {selectedIds.length > 1 && taxonomy.categories.length > 0 ? (
                    <aside className="nordea-edit-panel" ref={editPanelRef} style={{ top: editPanelTop }}>
                        <section className="nordea-bulk-summary">
                            <p>
                                <span className="nordea-bulk-amount">{formatSidebarAmount(selectedTotal)}</span>
                                <br />
                                baseret på {selectedRows.length} poster
                            </p>
                            <p>
                                Kategori for valgte:
                                <br />
                            </p>
                            <CategorySelect categories={taxonomy.categories} value="" onChange={(category) => category ? saveBulkCategory(category) : undefined} disabled={editControlsDisabled} autoFocus openOnFocus={false} bubbleClosedTableKeys />
                        </section>
                        <section>
                            <h5>Tags <small>– Opret nyt</small></h5>
                            <div className="nordea-tag-check-list">
                                {taxonomy.hashtags.map((hashtag) => {
                                    const checked = selectedRows.length > 0 && selectedRows.every((row) => rowHasHashtag(row, hashtag.name));
                                    return (
                                        <p className="nordea-tag-check" key={hashtag.name}>
                                            <label>
                                                <input type="checkbox" checked={checked} disabled={editControlsDisabled} onChange={(event) => toggleBulkHashtag(hashtag.name, event.target.checked)} />
                                                {hashtag.name}
                                            </label>
                                        </p>
                                    );
                                })}
                            </div>
                            <div className="nordea-tag-create">
                                <input list="nordea-hashtags" value={bulkHashtag} onChange={(event) => setBulkHashtag(event.target.value)} placeholder="Skriv hashtag" />
                                <button type="button" className="secondary-button" disabled={!bulkHashtag.trim() || editControlsDisabled} onClick={() => { void savePatch(selectedParentIds, { append_hashtags: [bulkHashtag.trim()] }); setBulkHashtag(""); }}>
                                    Tilføj
                                </button>
                            </div>
                        </section>
                    </aside>
                ) : selectedTransaction && selectedRow ? (
                    <aside className="nordea-edit-panel" ref={editPanelRef} style={{ top: editPanelTop }}>
                        <section>
                            <h5>Find lignende poster</h5>
                            <ul className="nordea-similar-list">
                                {similarWords(selectedTransaction).map((word) => (
                                    <li key={word}><button type="button" onClick={() => setSearchText(word)}>{word}</button></li>
                                ))}
                            </ul>
                        </section>
                        <section>
                            <h5>Skift dato</h5>
                            <div className="nordea-date-edit">
                                <input type="date" value={dateText} onChange={(event) => setDateText(event.target.value)} />
                                <button type="button" disabled={editControlsDisabled || !dateText} onClick={() => void savePatch([selectedTransaction.id], { booking_date: dateText })}>Gem</button>
                            </div>
                        </section>
                        <section>
                            <h5>Note</h5>
                            <NoteEditor entityId={selectedRow.rowId} note={selectedRow.note} hashtags={taxonomy.hashtags} saving={editControlsDisabled} onSave={(note) => saveRowNote(selectedRow, note)} />
                        </section>
                        <section>
                            <h5>Split beløbet</h5>
                            <p>{selectedRow.isSplitChild || hasEffectiveSplit(selectedTransaction) ? "Denne post er en del af et split" : "Ønsker du at angive mere præcist, hvad pengene er blevet brugt til?"}</p>
                            <button type="button" onClick={() => openSplitModal(selectedTransaction)}>{selectedRow.isSplitChild || hasEffectiveSplit(selectedTransaction) ? "Rediger split" : "Split beløb"}</button>
                        </section>
                        <label className="nordea-checkbox-label">
                            <input type="checkbox" checked={isExtraordinary} onChange={(event) => { setIsExtraordinary(event.target.checked); void savePatch([selectedTransaction.id], { is_extraordinary: event.target.checked }); }} />
                            Ekstraordinær
                        </label>
                        <p className="nordea-origin-text">
                            <span>Oprindelig dato: {formatTxDate(selectedTransaction.original_booking_date ?? selectedTransaction.booking_date)}</span>
                            <span>Oprindelig tekst: {selectedTransaction.remittance_information || selectedTransaction.description}</span>
                        </p>
                    </aside>
                ) : null}
            </section> : null}
            <datalist id="nordea-hashtags">
                {taxonomy.hashtags.map((hashtag) => <option key={hashtag.name} value={hashtag.name} />)}
            </datalist>
            {splitModalOpen && selectedTransaction ? (
                <div className="modal-backdrop nordea-split-backdrop" onClick={() => setSplitModalOpen(false)}>
                    <section className="spiir-transactions-modal nordea-split-modal" onClick={(event) => event.stopPropagation()}>
                        <div className="nordea-split-modal-header">
                            <div>
                                <h2>Split beløbet</h2>
                                <p>
                                    Split beløbet {formatPostingAmount(Math.abs(splitTotalAmount(selectedTransaction)))} for posten {selectedTransaction.description} fra {formatTxDate(selectedTransaction.booking_date)}.
                                </p>
                            </div>
                            <button type="button" className="nordea-split-close" onClick={() => setSplitModalOpen(false)} aria-label="Luk split">
                                ×
                            </button>
                        </div>
                        <div className="nordea-split-lines">
                            {splitLines.map((split, index) => (
                                <div key={split.id} className={split.locked ? "nordea-split-line nordea-split-line-locked" : "nordea-split-line"}>
                                    {split.locked ? (
                                        <span className="nordea-split-remove-placeholder" aria-hidden="true" />
                                    ) : (
                                        <button
                                            type="button"
                                            className="nordea-split-remove"
                                            onClick={() => setSplitDraftLines((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                                            aria-label="Fjern splitlinje"
                                        >
                                            ×
                                        </button>
                                    )}
                                    <CategorySelect categories={taxonomy.categories} value={categoryKey(split.category)} onChange={(category) => setSplitDraftLines((current) => current.map((item) => item.id === split.id ? { ...item, category } : item))} placeholder="Vælg kategori" />
                                    <input value={split.note} onChange={(event) => setSplitDraftLines((current) => current.map((item) => item.id === split.id ? { ...item, note: event.target.value } : item))} placeholder="Skriv note" />
                                    <input className="nordea-split-amount" type="text" inputMode="text" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={split.amountText} disabled={split.locked} onChange={(event) => setSplitDraftLines((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, amount: parseSplitDraftAmount(event.target.value), amountText: event.target.value } : item))} onBlur={() => setSplitDraftLines((current) => current.map((item, itemIndex) => itemIndex === index && Number.isFinite(item.amount) ? { ...item, amountText: formatSplitDraftAmount(item.amount) } : item))} />
                                </div>
                            ))}
                        </div>
                        {splitError ? <p className="nordea-split-error">{splitError}</p> : null}
                        <div className="nordea-split-actions">
                            <button type="button" className="nordea-split-add" onClick={() => setSplitDraftLines((current) => [...current, blankSplitLine()])}>Ny linje</button>
                            <button type="button" className="nordea-split-save" disabled={splitSaveDisabled} onClick={() => { void saveSplitLines(); }}>Gem split</button>
                        </div>
                    </section>
                </div>
            ) : null}
            {sunburstState ? (
                <SpiirSunburstModal
                    state={sunburstState}
                    transactions={spiirTransactions}
                    closeOnEscape={!sunburstDrilldownModal}
                    ensureTransactionsLoaded={ensureSpiirTransactionsLoaded}
                    onOpenTransactions={openSunburstDrilldown}
                    onClose={() => setSunburstState(null)}
                />
            ) : null}
            {sunburstDrilldownModal ? (
                <div className="modal-backdrop" onClick={() => setSunburstDrilldownModal(null)}>
                    <section className="nordea-drilldown-modal" onClick={(event) => event.stopPropagation()}>
                        <NordeaDashboard
                            key={`${sunburstDrilldownModal.title}|${sunburstDrilldownModal.periodFilter ?? "all"}|${sunburstDrilldownModal.categoryFilter?.categoryId ?? ""}|${sunburstDrilldownModal.searchText ?? ""}`}
                            active
                            source="local-ledger"
                            embedded
                            initialFilter={sunburstDrilldownModal}
                            onClose={() => setSunburstDrilldownModal(null)}
                        />
                    </section>
                </div>
            ) : null}
        </section>
    );
}