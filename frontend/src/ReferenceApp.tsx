import { Suspense, lazy, useState } from "react";

const KvitteringerDashboard = lazy(() => import("./KvitteringerDashboard"));
const NordeaDashboard = lazy(() => import("./NordeaDashboard"));
const SpiirDashboard = lazy(() => import("./SpiirDashboard"));

type Tab = "nordea" | "spiir" | "kvitteringer";

export default function ReferenceApp() {
    const [tab, setTab] = useState<Tab>("nordea");

    return <main className={tab === "nordea" ? "app-mode-nordea" : "app-shell app-shell-wide"}>
        <nav className="top-nav-panel" aria-label="Reference navigation">
            <div className="top-nav-start">
                <strong>Spiir alternative</strong>
            </div>
            <div className="top-nav-controls">
                <button type="button" className={tab === "nordea" ? "nav-pill active" : "nav-pill"} onClick={() => setTab("nordea")}>Nordea ledger</button>
                <button type="button" className={tab === "spiir" ? "nav-pill active" : "nav-pill"} onClick={() => setTab("spiir")}>Overview</button>
                <button type="button" className={tab === "kvitteringer" ? "nav-pill active" : "nav-pill"} onClick={() => setTab("kvitteringer")}>Receipts</button>
            </div>
            <div />
        </nav>
        <Suspense fallback={<div className="panel">Loading...</div>}>
            {tab === "nordea" ? <NordeaDashboard active={true} source="local-ledger" /> : null}
            {tab === "spiir" ? <SpiirDashboard active={true} /> : null}
            {tab === "kvitteringer" ? <KvitteringerDashboard active={true} /> : null}
        </Suspense>
    </main>;
}
