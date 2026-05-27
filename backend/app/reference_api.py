from __future__ import annotations

from datetime import UTC, date, datetime
from typing import Annotated, Any, Literal

from fastapi import FastAPI, File, HTTPException, Query, UploadFile, status

from .config import get_data_dir, get_kvitteringer_db_path, get_storebox_source_dir
from .kvitteringer_service import (
    get_item_cluster,
    get_kvitteringer_status,
    get_receipt,
    import_storebox_folder,
    item_price_history,
    item_purchase_history,
    kvitteringer_outliers,
    kvitteringer_overview,
    kvitteringer_overview_sunburst,
    link_spiir_transaction_to_receipt,
    list_item_clusters,
    list_merchants,
    list_receipts,
    rebuild_kvitteringer_indexes,
    replace_storebox_upload,
    set_item_cluster_category_override,
)
from .nordea_service import (
    get_nordea_retrieve_status,
    load_nordea_taxonomy,
    load_nordea_transactions,
    retrieve_nordea_transactions,
    save_nordea_overrides,
    start_nordea_retrieve_job,
)
from .spiir_local_ledger_service import (
    apply_nordea_sync_into_spiir_local_ledger,
    apply_spiir_local_ledger_import,
    apply_spiir_local_ledger_split_canonicalization,
    apply_spiir_local_ledger_split_fragment_repair,
    load_spiir_local_ledger_transactions,
    preview_nordea_sync_into_spiir_local_ledger,
    preview_spiir_local_ledger_import,
    preview_spiir_local_ledger_split_canonicalization,
    preview_spiir_local_ledger_split_fragment_repair,
    save_spiir_local_ledger_overrides,
)
from .spiir_service import (
    get_spiir_status,
    load_spiir_income_expense_series,
    load_spiir_overview,
    load_spiir_transactions,
    read_spiir_update_log,
    rebuild_spiir_processed,
    schedule_spiir_rebuild_if_due,
)
from .storage import ensure_runtime_dirs


def iso_utc() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def create_app() -> FastAPI:
    app = FastAPI(title="Spiir Alternative Reference API", version="0.1.0")

    @app.get("/api/status")
    def status_route() -> dict[str, object]:
        ensure_runtime_dirs()
        return {
            "status": "ok",
            "timestamp_utc": iso_utc(),
            "storage": {
                "data_dir": str(get_data_dir()),
                "storebox_source_dir": str(get_storebox_source_dir()),
                "kvitteringer_db_path": str(get_kvitteringer_db_path()),
            },
        }

    @app.get("/api/spiir/status")
    def spiir_status() -> dict[str, object]:
        payload = get_spiir_status()
        if payload.get("rebuild_required"):
            schedule_spiir_rebuild_if_due()
        return payload

    @app.post("/api/spiir/rebuild-from-local/schedule")
    def spiir_schedule_rebuild_from_local(delay_seconds: float = Query(10.0, ge=0, le=300)) -> dict[str, object]:
        return schedule_spiir_rebuild_if_due(delay_seconds=delay_seconds)

    @app.post("/api/spiir/rebuild-from-local")
    def spiir_rebuild_from_local() -> dict[str, object]:
        try:
            return rebuild_spiir_processed(source="local")
        except (FileNotFoundError, RuntimeError) as exc:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    @app.get("/api/spiir/overview")
    def spiir_overview() -> dict[str, object]:
        try:
            return load_spiir_overview()
        except FileNotFoundError as exc:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc

    @app.get("/api/spiir/transactions")
    def spiir_transactions() -> list[dict[str, object]]:
        try:
            return load_spiir_transactions()
        except FileNotFoundError as exc:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc

    @app.get("/api/spiir/update-log")
    def spiir_update_log() -> str:
        return read_spiir_update_log()

    @app.get("/api/spiir/local-ledger/preview")
    def local_ledger_preview(sample_limit: Annotated[int, Query(ge=1, le=200)] = 25) -> dict[str, object]:
        try:
            return preview_spiir_local_ledger_import(sample_limit=sample_limit)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc

    @app.post("/api/spiir/local-ledger/apply")
    def local_ledger_apply() -> dict[str, object]:
        try:
            return apply_spiir_local_ledger_import()
        except FileNotFoundError as exc:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc

    @app.get("/api/spiir/local-ledger/nordea-sync/preview")
    def nordea_sync_preview() -> dict[str, object]:
        try:
            return preview_nordea_sync_into_spiir_local_ledger()
        except (FileNotFoundError, ValueError) as exc:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    @app.post("/api/spiir/local-ledger/nordea-sync/apply")
    def nordea_sync_apply() -> dict[str, object]:
        try:
            return apply_nordea_sync_into_spiir_local_ledger()
        except (FileNotFoundError, ValueError) as exc:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    @app.get("/api/spiir/local-ledger/transactions")
    def local_ledger_transactions(
        limit: Annotated[int | None, Query(ge=1)] = None,
        offset: Annotated[int, Query(ge=0)] = 0,
    ) -> dict[str, object]:
        return load_spiir_local_ledger_transactions(limit=limit, offset=offset)

    @app.get("/api/spiir/local-ledger/income-expense-series")
    def local_ledger_income_expense_series() -> dict[str, object]:
        try:
            return load_spiir_income_expense_series()
        except (FileNotFoundError, ValueError) as exc:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    @app.post("/api/spiir/local-ledger/overrides")
    def local_ledger_overrides(payload: dict[str, Any]) -> dict[str, object]:
        try:
            transaction_ids = [str(item) for item in payload.get("transaction_ids") or [] if str(item).strip()]
            patch = payload.get("patch", {})
            if not isinstance(patch, dict):
                raise ValueError("Invalid local ledger patch")
            return save_spiir_local_ledger_overrides(transaction_ids, patch)
        except ValueError as exc:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    @app.get("/api/spiir/local-ledger/splits/migration-preview")
    def split_migration_preview(sample_limit: Annotated[int, Query(ge=1, le=200)] = 25) -> dict[str, object]:
        return preview_spiir_local_ledger_split_canonicalization(sample_limit=sample_limit)

    @app.post("/api/spiir/local-ledger/splits/migration-apply")
    def split_migration_apply() -> dict[str, object]:
        return apply_spiir_local_ledger_split_canonicalization()

    @app.get("/api/spiir/local-ledger/splits/repair-preview")
    def split_repair_preview(sample_limit: Annotated[int, Query(ge=1, le=200)] = 25) -> dict[str, object]:
        return preview_spiir_local_ledger_split_fragment_repair(sample_limit=sample_limit)

    @app.post("/api/spiir/local-ledger/splits/repair-apply")
    def split_repair_apply() -> dict[str, object]:
        return apply_spiir_local_ledger_split_fragment_repair()

    @app.get("/api/nordea/transactions")
    def nordea_transactions() -> dict[str, object]:
        return load_nordea_transactions()

    @app.get("/api/nordea/taxonomy")
    def nordea_taxonomy() -> dict[str, object]:
        return load_nordea_taxonomy()

    @app.post("/api/nordea/overrides")
    def nordea_overrides(payload: dict[str, Any]) -> dict[str, object]:
        try:
            transaction_ids = [str(item) for item in payload.get("transaction_ids", [])]
            patch = payload.get("patch", {})
            if not isinstance(patch, dict):
                raise ValueError("Invalid Nordea override patch")
            return save_nordea_overrides(transaction_ids, patch)
        except ValueError as exc:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    @app.post("/api/nordea/retrieve")
    def nordea_retrieve() -> dict[str, object]:
        try:
            return retrieve_nordea_transactions()
        except (FileNotFoundError, RuntimeError) as exc:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    @app.post("/api/nordea/retrieve/start")
    def nordea_retrieve_start() -> dict[str, object]:
        return start_nordea_retrieve_job(sync_local_ledger=True)

    @app.get("/api/nordea/retrieve/status")
    def nordea_retrieve_status() -> dict[str, object]:
        return get_nordea_retrieve_status()

    @app.get("/api/kvitteringer/status")
    def kvitteringer_status() -> dict[str, object]:
        return get_kvitteringer_status()

    @app.post("/api/kvitteringer/import/default")
    def kvitteringer_import_default() -> dict[str, object]:
        try:
            return import_storebox_folder()
        except (FileNotFoundError, ValueError) as exc:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    @app.post("/api/kvitteringer/import/upload")
    async def kvitteringer_import_upload(file: UploadFile = File(...)) -> dict[str, object]:
        try:
            return replace_storebox_upload(await file.read(), file.filename)
        except (FileNotFoundError, ValueError) as exc:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
        finally:
            await file.close()

    @app.post("/api/kvitteringer/rebuild")
    def kvitteringer_rebuild() -> dict[str, object]:
        return rebuild_kvitteringer_indexes()

    @app.get("/api/kvitteringer/overview")
    def kvitteringer_summary(
        granularity: Literal["month", "year"] = "month",
        date_from: date | None = None,
        date_to: date | None = None,
        merchant_keys: list[str] | None = Query(default=None),
    ) -> dict[str, object]:
        return kvitteringer_overview(granularity=granularity, date_from=date_from, date_to=date_to, merchant_keys=merchant_keys)

    @app.get("/api/kvitteringer/overview/sunburst")
    def kvitteringer_summary_sunburst(
        granularity: Literal["month", "year"] = "month",
        periods: list[str] | None = Query(default=None),
        merchant_keys: list[str] | None = Query(default=None),
    ) -> dict[str, object]:
        return kvitteringer_overview_sunburst(granularity=granularity, periods=periods or [], merchant_keys=merchant_keys)

    @app.get("/api/kvitteringer/receipts")
    def kvitteringer_receipts(
        date_from: date | None = None,
        date_to: date | None = None,
        merchant_keys: list[str] | None = Query(default=None),
    ) -> list[dict[str, object]]:
        return list_receipts(date_from=date_from, date_to=date_to, merchant_keys=merchant_keys)

    @app.get("/api/kvitteringer/receipts/{receipt_id}")
    def kvitteringer_receipt(receipt_id: str) -> dict[str, object]:
        payload = get_receipt(receipt_id)
        if payload is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Receipt not found")
        return payload

    @app.get("/api/kvitteringer/merchants")
    def kvitteringer_merchants(
        date_from: date | None = None,
        date_to: date | None = None,
        merchant_keys: list[str] | None = Query(default=None),
    ) -> list[dict[str, object]]:
        return list_merchants(date_from=date_from, date_to=date_to, merchant_keys=merchant_keys)

    @app.get("/api/kvitteringer/items")
    def kvitteringer_items(
        search: str | None = None,
        date_from: date | None = None,
        date_to: date | None = None,
        merchant_keys: list[str] | None = Query(default=None),
    ) -> list[dict[str, object]]:
        return list_item_clusters(search=search, date_from=date_from, date_to=date_to, merchant_keys=merchant_keys)

    @app.get("/api/kvitteringer/items/{cluster_id}")
    def kvitteringer_item(cluster_id: str) -> dict[str, object]:
        payload = get_item_cluster(cluster_id)
        if payload is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Item cluster not found")
        return payload

    @app.post("/api/kvitteringer/items/{cluster_id}/category-override")
    def kvitteringer_item_category_override(cluster_id: str, payload: dict[str, Any]) -> dict[str, object]:
        result = set_item_cluster_category_override(cluster_id, payload.get("category_key"))
        if result is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Item cluster not found")
        return result

    @app.get("/api/kvitteringer/items/{cluster_id}/history")
    def kvitteringer_item_history_route(
        cluster_id: str,
        date_from: date | None = None,
        date_to: date | None = None,
        merchant_keys: list[str] | None = Query(default=None),
    ) -> list[dict[str, object]]:
        return item_purchase_history(cluster_id, date_from=date_from, date_to=date_to, merchant_keys=merchant_keys)

    @app.get("/api/kvitteringer/items/{cluster_id}/price-history")
    def kvitteringer_item_price_history_route(
        cluster_id: str,
        date_from: date | None = None,
        date_to: date | None = None,
        merchant_keys: list[str] | None = Query(default=None),
    ) -> list[dict[str, object]]:
        return item_price_history(cluster_id, date_from=date_from, date_to=date_to, merchant_keys=merchant_keys)

    @app.get("/api/kvitteringer/outliers")
    def kvitteringer_outliers_route() -> dict[str, object]:
        return kvitteringer_outliers()

    @app.post("/api/kvitteringer/spiir-link")
    def kvitteringer_spiir_link(payload: dict[str, Any]) -> dict[str, object]:
        return link_spiir_transaction_to_receipt(payload)

    return app


app = create_app()
