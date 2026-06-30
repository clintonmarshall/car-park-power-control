"""Management reporting helpers for ParkPower."""

from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime, timedelta
from typing import Any


def build_management_report(
    *,
    billing_report: dict[str, Any],
    session_data: dict[str, Any],
    records: dict[str, Any],
    outlets: list[dict[str, Any]],
    filters: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build Phase 4 reporting data from current local stores."""
    filters = filters or {}
    completed = [dict(session) for session in billing_report.get("completed", []) if isinstance(session, dict)]
    active = [dict(session) for session in billing_report.get("active", []) if isinstance(session, dict)]
    managed_sessions = [dict(session) for session in session_data.get("sessions", []) if isinstance(session, dict)]
    filtered_completed = _filter_sessions(completed, filters)
    currency = billing_report.get("settings", {}).get("currency", "AUD")
    today_start = _start_of_day()
    month_start = today_start.replace(day=1)

    kpis = _build_kpis(
        outlets=outlets,
        active=active,
        completed=completed,
        filtered_completed=filtered_completed,
        managed_sessions=managed_sessions,
        today_start=today_start,
        month_start=month_start,
    )
    charts = _build_charts(filtered_completed, outlets)
    statement = _monthly_statement(filtered_completed, currency)
    rows = [_report_row(session, records) for session in filtered_completed]

    return {
        "filters": filters,
        "currency": currency,
        "kpis": kpis,
        "charts": charts,
        "statement": statement,
        "sessions": rows,
        "billing_states": ["draft", "approved", "invoiced", "paid", "waived", "disputed"],
    }


def _filter_sessions(sessions: list[dict[str, Any]], filters: dict[str, Any]) -> list[dict[str, Any]]:
    """Apply report filters to completed billing sessions."""
    start = _parse_time(filters.get("start"))
    end = _parse_time(filters.get("end"))
    outlet = str(filters.get("outlet") or "").strip()
    reference = str(filters.get("reference") or "").strip().lower()
    billing_status = str(filters.get("billing_status") or "").strip()
    rows = []
    for session in sessions:
        session_time = _parse_time(session.get("end_time") or session.get("start_time"))
        if start and session_time and session_time < start:
            continue
        if end and session_time and session_time > end:
            continue
        if outlet and session.get("switch_entity_id") != outlet:
            continue
        if reference and reference not in str(session.get("reference") or "").lower():
            continue
        if billing_status and str(session.get("billing_status") or "draft") != billing_status:
            continue
        rows.append(session)
    return rows


def _build_kpis(
    *,
    outlets: list[dict[str, Any]],
    active: list[dict[str, Any]],
    completed: list[dict[str, Any]],
    filtered_completed: list[dict[str, Any]],
    managed_sessions: list[dict[str, Any]],
    today_start: datetime,
    month_start: datetime,
) -> dict[str, Any]:
    """Calculate management KPIs."""
    outlet_count = len(outlets)
    outlet_states = Counter(str(outlet.get("state") or "unknown") for outlet in outlets)
    active_ids = {session.get("switch_entity_id") for session in active}
    waiting_states = {"authorised", "waiting_for_load", "idle_grace_period"}
    waiting = sum(1 for session in managed_sessions if session.get("state") in waiting_states)
    paused = sum(1 for session in managed_sessions if session.get("state") == "paused_load_limit")
    faulted = sum(1 for session in managed_sessions if session.get("state") in {"fault", "requires_review"})
    today_sessions = [session for session in completed if _after(session.get("end_time"), today_start)]
    month_sessions = [session for session in completed if _after(session.get("end_time"), month_start)]
    energy_total = sum(_number(session.get("energy_kwh")) for session in filtered_completed)
    cost_total = sum(_number(session.get("cost")) for session in filtered_completed)
    duration_total = sum(_number(session.get("duration_seconds")) for session in filtered_completed)
    live_power = sum(_number(outlet.get("power_w")) for outlet in outlets)
    average_sessions = max(len(filtered_completed), 1)

    return {
        "total_managed_outlets": outlet_count,
        "available_outlets": max(0, outlet_count - len(active_ids)),
        "active_charging_outlets": len(active_ids),
        "waiting_outlets": waiting,
        "load_managed_paused_outlets": paused,
        "offline_outlets": outlet_states.get("unavailable", 0) + outlet_states.get("unknown", 0),
        "faulted_outlets": faulted,
        "sessions_today": len(today_sessions),
        "energy_today": round(sum(_number(session.get("energy_kwh")) for session in today_sessions), 4),
        "energy_this_month": round(sum(_number(session.get("energy_kwh")) for session in month_sessions), 4),
        "estimated_cost_recovery": round(cost_total, 4),
        "peak_charging_demand": round(live_power, 2),
        "average_kwh_per_session": round(energy_total / average_sessions, 4),
        "average_charging_duration": round(duration_total / average_sessions),
        "utilisation_percentage": round((len(active_ids) / outlet_count) * 100, 2) if outlet_count else 0,
    }


def _build_charts(sessions: list[dict[str, Any]], outlets: list[dict[str, Any]]) -> dict[str, Any]:
    """Return small chart-ready series."""
    energy_by_day: defaultdict[str, float] = defaultdict(float)
    sessions_by_day: defaultdict[str, int] = defaultdict(int)
    charging_by_hour: defaultdict[str, float] = defaultdict(float)
    charging_by_weekday: defaultdict[str, float] = defaultdict(float)
    top_outlets: defaultdict[str, float] = defaultdict(float)
    costs: defaultdict[str, float] = defaultdict(float)

    for session in sessions:
        end_time = _parse_time(session.get("end_time") or session.get("start_time"))
        if end_time is None:
            continue
        day = end_time.date().isoformat()
        hour = f"{end_time.hour:02d}:00"
        weekday = end_time.strftime("%A")
        energy = _number(session.get("energy_kwh"))
        cost = _number(session.get("cost"))
        outlet = str(session.get("outlet_name") or session.get("switch_entity_id") or "Unknown")
        energy_by_day[day] += energy
        sessions_by_day[day] += 1
        charging_by_hour[hour] += energy
        charging_by_weekday[weekday] += energy
        top_outlets[outlet] += energy
        costs[day] += cost

    return {
        "energy_by_day": _series(energy_by_day),
        "sessions_by_day": _series(sessions_by_day),
        "charging_by_hour": _series(charging_by_hour),
        "charging_by_day_of_week": _series(charging_by_weekday),
        "top_outlets": _top_series(top_outlets),
        "top_customers": [],
        "energy_by_user_group": [],
        "costs_and_recoverable_amounts": _series(costs),
        "site_load_vs_limit": [
            {"label": outlet.get("name") or outlet.get("id"), "value": _number(outlet.get("power_w"))}
            for outlet in outlets
            if _number(outlet.get("power_w")) > 0
        ],
    }


def _monthly_statement(sessions: list[dict[str, Any]], currency: str) -> dict[str, Any]:
    """Build current monthly statement totals."""
    energy = sum(_number(session.get("energy_kwh")) for session in sessions)
    cost = sum(_number(session.get("cost")) for session in sessions)
    invoiced = sum(_number(session.get("cost")) for session in sessions if session.get("billing_status") == "invoiced")
    paid = sum(_number(session.get("cost")) for session in sessions if session.get("billing_status") == "paid")
    waived = sum(_number(session.get("cost")) for session in sessions if session.get("billing_status") == "waived")
    return {
        "currency": currency,
        "billing_period": "filtered",
        "total_measured_charging_energy": round(energy, 4),
        "underlying_electricity_cost": round(cost, 4),
        "energy_charges": round(cost, 4),
        "session_charges": 0,
        "management_fees": 0,
        "discounts": 0,
        "waived_sessions": round(waived, 4),
        "manual_adjustments": 0,
        "total_recoverable_amount": round(max(0, cost - waived), 4),
        "amount_marked_invoiced": round(invoiced, 4),
        "amount_marked_paid": round(paid, 4),
        "outstanding_amount": round(max(0, cost - waived - paid), 4),
    }


def _report_row(session: dict[str, Any], records: dict[str, Any]) -> dict[str, Any]:
    """Return a CSV/report-friendly session row."""
    return {
        "start": session.get("start_time", ""),
        "end": session.get("end_time", ""),
        "outlet": session.get("outlet_name", ""),
        "switch_entity_id": session.get("switch_entity_id", ""),
        "reference": session.get("reference", ""),
        "customer": _record_name(records.get("customers", []), session.get("customer_id")),
        "vehicle": _record_name(records.get("vehicles", []), session.get("vehicle_id"), "registration"),
        "user_group": _record_name(records.get("user_groups", []), session.get("user_group"), "name"),
        "duration_seconds": session.get("duration_seconds", 0),
        "energy_kwh": session.get("energy_kwh", 0),
        "cost": session.get("cost", 0),
        "billing_status": session.get("billing_status", "draft"),
        "currency": session.get("currency", ""),
    }


def _series(values: dict[str, float | int]) -> list[dict[str, Any]]:
    return [{"label": key, "value": round(value, 4) if isinstance(value, float) else value} for key, value in sorted(values.items())]


def _top_series(values: dict[str, float], limit: int = 10) -> list[dict[str, Any]]:
    rows = sorted(values.items(), key=lambda item: item[1], reverse=True)[:limit]
    return [{"label": key, "value": round(value, 4)} for key, value in rows]


def _record_name(records: list[dict[str, Any]], record_id: Any, key: str = "display_name") -> str:
    return next((str(record.get(key) or "") for record in records if record.get("id") == record_id), "")


def _parse_time(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value))
    except ValueError:
        return None


def _start_of_day() -> datetime:
    now = datetime.now().astimezone()
    return now.replace(hour=0, minute=0, second=0, microsecond=0)


def _after(value: Any, threshold: datetime) -> bool:
    parsed = _parse_time(value)
    return bool(parsed and parsed >= threshold)


def default_filter_period(period: str) -> dict[str, str]:
    """Return start/end ISO filters for a named period."""
    now = datetime.now().astimezone()
    start = _start_of_day()
    if period == "week":
        start = start - timedelta(days=6)
    elif period == "month":
        start = start.replace(day=1)
    elif period == "all":
        return {}
    return {"start": start.isoformat(timespec="seconds"), "end": now.isoformat(timespec="seconds")}


def _number(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0
