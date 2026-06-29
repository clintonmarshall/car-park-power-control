"""Sonoff POW Energy Reporter integration."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any

import voluptuous as vol
from homeassistant.components import frontend, panel_custom, websocket_api
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers import area_registry as ar
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers import floor_registry as fr
from homeassistant.helpers import label_registry as lr
from homeassistant.helpers.storage import Store
import homeassistant.helpers.config_validation as cv

from .const import (
    CONF_DASHBOARD_NAME,
    CONF_ENTITY_FILTER,
    CONF_ENABLE_CUSTOMER_PORTAL,
    CONF_LOGO_URL,
    CONF_PORTAL_NAME,
    CONF_PORTAL_URL_PATH,
    CONF_SIDEBAR_ICON,
    CONF_URL_PATH,
    DEFAULT_DASHBOARD_NAME,
    DEFAULT_ENTITY_FILTER,
    DEFAULT_PORTAL_NAME,
    DEFAULT_PORTAL_URL_PATH,
    DEFAULT_SIDEBAR_ICON,
    DEFAULT_URL_PATH,
    DOMAIN,
    PANEL_JS_URL,
)

PLATFORMS: list[Platform] = []
STORAGE_KEY = f"{DOMAIN}.outlet_log"
BILLING_STORAGE_KEY = f"{DOMAIN}.billing"
STORAGE_VERSION = 1
MAX_LOG_ROWS = 2000
MAX_SESSION_ROWS = 10000
DEFAULT_ENERGY_RATE = 0.32

CONFIG_SCHEMA = vol.Schema(
    {
        DOMAIN: vol.Schema(
            {
                vol.Optional(CONF_DASHBOARD_NAME, default=DEFAULT_DASHBOARD_NAME): cv.string,
                vol.Optional(CONF_URL_PATH, default=DEFAULT_URL_PATH): cv.string,
                vol.Optional(CONF_SIDEBAR_ICON, default=DEFAULT_SIDEBAR_ICON): cv.icon,
                vol.Optional(CONF_LOGO_URL, default=""): cv.string,
                vol.Optional(
                    CONF_ENTITY_FILTER,
                    default=DEFAULT_ENTITY_FILTER,
                ): cv.string,
                vol.Optional(CONF_ENABLE_CUSTOMER_PORTAL, default=True): cv.boolean,
                vol.Optional(CONF_PORTAL_NAME, default=DEFAULT_PORTAL_NAME): cv.string,
                vol.Optional(CONF_PORTAL_URL_PATH, default=DEFAULT_PORTAL_URL_PATH): cv.string,
            }
        )
    },
    extra=vol.ALLOW_EXTRA,
)


async def async_setup(hass: HomeAssistant, config: dict[str, Any]) -> bool:
    """Set up the dashboard from YAML."""
    _async_register_websocket_commands(hass)

    yaml_config = config.get(DOMAIN)
    if yaml_config is None:
        return True

    await _async_register_dashboard(hass, yaml_config)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up the reporting dashboard panel."""
    _async_register_websocket_commands(hass)

    options = {**entry.data, **entry.options}
    await _async_register_dashboard(hass, options)

    entry.async_on_unload(
        entry.add_update_listener(_async_update_listener)
    )
    entry.async_on_unload(
        lambda: frontend.async_remove_panel(
            hass,
            options.get(CONF_URL_PATH, DEFAULT_URL_PATH),
        )
    )
    entry.async_on_unload(
        lambda: frontend.async_remove_panel(
            hass,
            options.get(CONF_PORTAL_URL_PATH, DEFAULT_PORTAL_URL_PATH),
        )
    )
    return True


async def _async_register_dashboard(
    hass: HomeAssistant,
    options: dict[str, Any],
) -> None:
    """Register the reporting dashboard panel."""
    url_path = options.get(CONF_URL_PATH, DEFAULT_URL_PATH)
    sidebar_title = options.get(CONF_DASHBOARD_NAME, DEFAULT_DASHBOARD_NAME)
    sidebar_icon = options.get(CONF_SIDEBAR_ICON, DEFAULT_SIDEBAR_ICON)
    entity_filter = options.get(CONF_ENTITY_FILTER, DEFAULT_ENTITY_FILTER)
    logo_url = options.get(CONF_LOGO_URL, "")

    panel_path = Path(__file__).parent / "frontend" / "pow-reporting-panel.js"
    await hass.http.async_register_static_paths(
        [
            StaticPathConfig(
                PANEL_JS_URL,
                str(panel_path),
                cache_headers=False,
            )
        ]
    )

    await panel_custom.async_register_panel(
        hass,
        webcomponent_name="pow-reporting-panel",
        frontend_url_path=url_path,
        sidebar_title=sidebar_title,
        sidebar_icon=sidebar_icon,
        require_admin=False,
        module_url=PANEL_JS_URL,
        config={
            "name": sidebar_title,
            "logo_url": logo_url,
            "entity_filter": entity_filter,
            "mode": "admin",
        },
    )

    if options.get(CONF_ENABLE_CUSTOMER_PORTAL, True):
        portal_url_path = options.get(CONF_PORTAL_URL_PATH, DEFAULT_PORTAL_URL_PATH)
        portal_title = options.get(CONF_PORTAL_NAME, DEFAULT_PORTAL_NAME)
        await panel_custom.async_register_panel(
            hass,
            webcomponent_name="pow-reporting-panel",
            frontend_url_path=portal_url_path,
            sidebar_title=portal_title,
            sidebar_icon="mdi:ev-station",
            require_admin=False,
            module_url=PANEL_JS_URL,
            config={
                "name": portal_title,
                "logo_url": logo_url,
                "entity_filter": entity_filter,
                "mode": "portal",
            },
        )


def _async_register_websocket_commands(hass: HomeAssistant) -> None:
    """Register websocket commands once."""
    if hass.data.setdefault(DOMAIN, {}).get("websocket_registered"):
        return

    websocket_api.async_register_command(hass, _websocket_get_outlet_log)
    websocket_api.async_register_command(hass, _websocket_get_billing_report)
    websocket_api.async_register_command(hass, _websocket_save_billing_settings)
    websocket_api.async_register_command(hass, _websocket_control_outlet)
    websocket_api.async_register_command(hass, _websocket_all_off)
    websocket_api.async_register_command(hass, _websocket_auto_name_entities)
    hass.data[DOMAIN]["websocket_registered"] = True


async def _async_load_log(hass: HomeAssistant) -> dict[str, Any]:
    """Load outlet audit log data."""
    store = Store(hass, STORAGE_VERSION, STORAGE_KEY)
    data = await store.async_load()
    if not isinstance(data, dict):
        return {"events": [], "active_references": {}}
    data.setdefault("events", [])
    data.setdefault("active_references", {})
    return data


async def _async_save_log(hass: HomeAssistant, data: dict[str, Any]) -> None:
    """Save outlet audit log data."""
    data["events"] = data.get("events", [])[-MAX_LOG_ROWS:]
    store = Store(hass, STORAGE_VERSION, STORAGE_KEY)
    await store.async_save(data)


async def _async_log_outlet_event(
    hass: HomeAssistant,
    *,
    switch_entity_id: str,
    action: str,
    reference: str,
    outlet_name: str,
    success: bool,
    error: str = "",
) -> dict[str, Any]:
    """Append an outlet control event."""
    data = await _async_load_log(hass)
    event = {
        "time": datetime.now().astimezone().isoformat(timespec="seconds"),
        "switch_entity_id": switch_entity_id,
        "outlet_name": outlet_name,
        "action": action,
        "reference": reference,
        "success": success,
        "error": error,
    }
    data["events"].append(event)

    if success and action == "turn_on":
        data["active_references"][switch_entity_id] = reference
    elif success and action == "turn_off":
        data["active_references"].pop(switch_entity_id, None)

    await _async_save_log(hass, data)
    return event


async def _async_load_billing(hass: HomeAssistant) -> dict[str, Any]:
    """Load persisted billing/session data."""
    store = Store(hass, STORAGE_VERSION, BILLING_STORAGE_KEY)
    data = await store.async_load()
    if not isinstance(data, dict):
        data = {}
    settings = data.get("settings")
    if not isinstance(settings, dict):
        settings = {}
    settings.setdefault("energy_rate", DEFAULT_ENERGY_RATE)
    settings.setdefault("currency", "AUD")
    active = data.get("active")
    if not isinstance(active, dict):
        active = {}
    completed = data.get("completed")
    if not isinstance(completed, list):
        completed = []
    return {"settings": settings, "active": active, "completed": completed}


async def _async_save_billing(hass: HomeAssistant, data: dict[str, Any]) -> None:
    """Persist billing/session data."""
    data["completed"] = data.get("completed", [])[-MAX_SESSION_ROWS:]
    store = Store(hass, STORAGE_VERSION, BILLING_STORAGE_KEY)
    await store.async_save(data)


def _normalise_energy_kwh(state: Any) -> float | None:
    """Return an energy state as kWh."""
    if state is None:
        return None
    try:
        value = float(state.state)
    except (TypeError, ValueError):
        return None
    unit = state.attributes.get("unit_of_measurement")
    if unit == "Wh":
        return value / 1000
    return value


def _find_device_energy_state(hass: HomeAssistant, switch_entity_id: str) -> Any:
    """Find the most useful energy sensor for a switch's device."""
    entity_registry = er.async_get(hass)
    switch_entry = entity_registry.async_get(switch_entity_id)
    device_id = getattr(switch_entry, "device_id", None)
    if not device_id:
        return None

    candidates = []
    for entry in getattr(entity_registry, "entities", {}).values():
        if getattr(entry, "device_id", None) != device_id or not entry.entity_id.startswith("sensor."):
            continue
        state = hass.states.get(entry.entity_id)
        if state is None:
            continue
        unit = state.attributes.get("unit_of_measurement")
        device_class = state.attributes.get("device_class")
        if device_class == "energy" or unit in {"Wh", "kWh"}:
            text = " ".join(
                str(item or "")
                for item in [
                    entry.entity_id,
                    state.attributes.get("friendly_name"),
                    getattr(entry, "original_name", None),
                ]
            ).lower()
            score = 10
            if "daily" in text:
                score += 10
            if "total" in text and "daily" not in text:
                score -= 2
            candidates.append((score, state))
    if not candidates:
        return None
    candidates.sort(key=lambda item: item[0])
    return candidates[0][1]


def _session_cost(energy_kwh: float | None, rate: float) -> float | None:
    """Calculate session cost when energy is available."""
    if energy_kwh is None:
        return None
    return round(energy_kwh * rate, 4)


async def _async_record_session_event(
    hass: HomeAssistant,
    *,
    switch_entity_id: str,
    action: str,
    reference: str,
    outlet_name: str,
    event: dict[str, Any],
) -> None:
    """Start or complete a persisted billing session."""
    if not event.get("success"):
        return

    data = await _async_load_billing(hass)
    settings = data["settings"]
    energy_state = _find_device_energy_state(hass, switch_entity_id)
    energy_entity_id = energy_state.entity_id if energy_state is not None else ""
    energy_kwh = _normalise_energy_kwh(energy_state)
    now = event.get("time") or datetime.now().astimezone().isoformat(timespec="seconds")

    if action == "turn_on":
        data["active"][switch_entity_id] = {
            "switch_entity_id": switch_entity_id,
            "outlet_name": outlet_name,
            "reference": reference,
            "start_time": now,
            "start_energy_kwh": energy_kwh,
            "energy_entity_id": energy_entity_id,
            "rate": float(settings.get("energy_rate", DEFAULT_ENERGY_RATE) or DEFAULT_ENERGY_RATE),
            "currency": settings.get("currency", "AUD"),
        }
    elif action == "turn_off":
        active = data["active"].pop(switch_entity_id, None)
        if active is not None:
            start_time = datetime.fromisoformat(active["start_time"])
            end_time = datetime.fromisoformat(now)
            start_energy = active.get("start_energy_kwh")
            energy_used = (
                max(0, energy_kwh - start_energy)
                if energy_kwh is not None and isinstance(start_energy, (int, float))
                else None
            )
            rate = float(active.get("rate", settings.get("energy_rate", DEFAULT_ENERGY_RATE)) or DEFAULT_ENERGY_RATE)
            data["completed"].append(
                {
                    **active,
                    "reference": reference or active.get("reference", ""),
                    "outlet_name": outlet_name or active.get("outlet_name", switch_entity_id),
                    "end_time": now,
                    "end_energy_kwh": energy_kwh,
                    "duration_seconds": max(0, round((end_time - start_time).total_seconds())),
                    "energy_kwh": round(energy_used, 4) if energy_used is not None else None,
                    "cost": _session_cost(energy_used, rate),
                }
            )

    await _async_save_billing(hass, data)


def _billing_report(data: dict[str, Any]) -> dict[str, Any]:
    """Return billing data with active durations and completed costs."""
    now = datetime.now().astimezone()
    settings = data["settings"]
    rate = float(settings.get("energy_rate", DEFAULT_ENERGY_RATE) or DEFAULT_ENERGY_RATE)
    active = []
    for session in data["active"].values():
        start_time = datetime.fromisoformat(session["start_time"])
        active.append(
            {
                **session,
                "active": True,
                "duration_seconds": max(0, round((now - start_time).total_seconds())),
                "energy_kwh": None,
                "cost": None,
            }
        )
    completed = []
    for session in data["completed"]:
        session_rate = float(session.get("rate", rate) or rate)
        energy_kwh = session.get("energy_kwh")
        completed.append(
            {
                **session,
                "active": False,
                "cost": session.get("cost") if session.get("cost") is not None else _session_cost(energy_kwh, session_rate),
            }
        )
    return {
        "settings": settings,
        "active": active,
        "completed": completed,
        "sessions": [*completed, *active],
    }


@websocket_api.websocket_command(
    {
        vol.Required("type"): "pow_reporting/get_outlet_log",
    }
)
@websocket_api.async_response
async def _websocket_get_outlet_log(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Return outlet audit log data."""
    connection.send_result(msg["id"], await _async_load_log(hass))


@websocket_api.websocket_command(
    {
        vol.Required("type"): "pow_reporting/get_billing_report",
    }
)
@websocket_api.async_response
async def _websocket_get_billing_report(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Return persisted billing/session report data."""
    connection.send_result(msg["id"], _billing_report(await _async_load_billing(hass)))


@websocket_api.websocket_command(
    {
        vol.Required("type"): "pow_reporting/save_billing_settings",
        vol.Optional("energy_rate", default=DEFAULT_ENERGY_RATE): vol.Coerce(float),
        vol.Optional("currency", default="AUD"): cv.string,
    }
)
@websocket_api.async_response
async def _websocket_save_billing_settings(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Persist billing report settings."""
    data = await _async_load_billing(hass)
    energy_rate = max(0, float(msg["energy_rate"]))
    data["settings"] = {
        **data["settings"],
        "energy_rate": energy_rate,
        "currency": msg["currency"].strip() or "AUD",
    }
    await _async_save_billing(hass, data)
    connection.send_result(msg["id"], _billing_report(data))


@websocket_api.websocket_command(
    {
        vol.Required("type"): "pow_reporting/control_outlet",
        vol.Required("switch_entity_id"): cv.entity_id,
        vol.Required("action"): vol.In(["turn_on", "turn_off"]),
        vol.Optional("reference", default=""): cv.string,
        vol.Optional("outlet_name", default=""): cv.string,
    }
)
@websocket_api.async_response
async def _websocket_control_outlet(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Turn one outlet on or off and log the action."""
    switch_entity_id = msg["switch_entity_id"]
    action = msg["action"]
    reference = msg["reference"].strip()
    outlet_name = msg["outlet_name"].strip() or switch_entity_id

    try:
        await hass.services.async_call(
            "switch",
            action,
            {"entity_id": switch_entity_id},
            blocking=True,
        )
    except Exception as err:  # noqa: BLE001 - surfaced to the dashboard
        event = await _async_log_outlet_event(
            hass,
            switch_entity_id=switch_entity_id,
            action=action,
            reference=reference,
            outlet_name=outlet_name,
            success=False,
            error=str(err),
        )
        connection.send_result(msg["id"], {"event": event})
        return

    event = await _async_log_outlet_event(
        hass,
        switch_entity_id=switch_entity_id,
        action=action,
        reference=reference,
        outlet_name=outlet_name,
        success=True,
    )
    await _async_record_session_event(
        hass,
        switch_entity_id=switch_entity_id,
        action=action,
        reference=reference,
        outlet_name=outlet_name,
        event=event,
    )
    connection.send_result(msg["id"], {"event": event})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "pow_reporting/all_off",
        vol.Required("switch_entity_ids"): vol.All(cv.ensure_list, [cv.entity_id]),
        vol.Optional("reference", default="Master ALL Off"): cv.string,
    }
)
@websocket_api.async_response
async def _websocket_all_off(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Turn all supplied outlets off and log each outlet."""
    reference = msg["reference"].strip() or "Master ALL Off"
    events = []

    for switch_entity_id in msg["switch_entity_ids"]:
        outlet_name = hass.states.get(switch_entity_id)
        name = outlet_name.attributes.get("friendly_name", switch_entity_id) if outlet_name else switch_entity_id
        try:
            await hass.services.async_call(
                "switch",
                "turn_off",
                {"entity_id": switch_entity_id},
                blocking=True,
            )
            event = await _async_log_outlet_event(
                hass,
                switch_entity_id=switch_entity_id,
                action="turn_off",
                reference=reference,
                outlet_name=name,
                success=True,
            )
            await _async_record_session_event(
                hass,
                switch_entity_id=switch_entity_id,
                action="turn_off",
                reference=reference,
                outlet_name=name,
                event=event,
            )
            events.append(event)
        except Exception as err:  # noqa: BLE001 - surfaced to the dashboard
            events.append(
                await _async_log_outlet_event(
                    hass,
                    switch_entity_id=switch_entity_id,
                    action="turn_off",
                    reference=reference,
                    outlet_name=name,
                    success=False,
                    error=str(err),
                )
            )

    connection.send_result(msg["id"], {"events": events})


def _registry_get(registry: Any, collection: str, key: str) -> Any:
    """Return a registry entry by key across HA registry implementations."""
    getter = getattr(registry, f"async_get_{collection[:-1]}", None)
    if getter:
        found = getter(key)
        if found is not None:
            return found
    generic_getter = getattr(registry, "async_get", None)
    if generic_getter:
        found = generic_getter(key)
        if found is not None:
            return found
    values = getattr(registry, collection, None) or getattr(registry, f"_{collection}", None) or {}
    if hasattr(values, "get"):
        return values.get(key)
    data = getattr(values, "data", {})
    if hasattr(data, "get"):
        return data.get(key)
    return None


def _label_entries(label_registry: Any, label_ids: list[str]) -> list[Any]:
    """Return label entries for a list of label ids."""
    labels = []
    for label_id in label_ids:
        label = _registry_get(label_registry, "labels", label_id)
        if label is not None:
            labels.append(label)
    return labels


def _entry_name(entry: Any) -> str:
    """Return a display-ish name for a registry entry."""
    return getattr(entry, "name", None) or getattr(entry, "name_by_user", None) or ""


def _area_for_entity(
    entity_entry: Any,
    device_entry: Any,
    area_registry: Any,
) -> Any:
    """Resolve the effective area for an entity/device."""
    area_id = getattr(entity_entry, "area_id", None) or getattr(device_entry, "area_id", None)
    if not area_id:
        return None
    return _registry_get(area_registry, "areas", area_id)


def _floor_for_area(area_entry: Any, floor_registry: Any) -> Any:
    """Resolve the floor for an area."""
    floor_id = getattr(area_entry, "floor_id", None)
    if not floor_id:
        return None
    return _registry_get(floor_registry, "floors", floor_id)


def _normalise_level_name(
    floor_entry: Any,
    area_entry: Any,
    labels: list[Any],
    extra_texts: list[str],
) -> str:
    """Return compact level text such as L1 or B2."""
    candidates = [
        _entry_name(floor_entry),
        _entry_name(area_entry),
        *[_entry_name(label) for label in labels],
        *extra_texts,
    ]
    for candidate in candidates:
        text = candidate or ""
        lowered = text.lower()
        match = __import__("re").search(r"(?:level|lvl|l)\s*([0-9]+)", lowered)
        if match:
            return f"L{match.group(1)}"
        match = __import__("re").search(r"(?:basement|b)\s*([0-9]+)", lowered)
        if match:
            return f"B{match.group(1)}"
    floor_level = getattr(floor_entry, "level", None)
    if isinstance(floor_level, int):
        return f"L{floor_level}" if floor_level >= 0 else f"B{abs(floor_level)}"
    return (_entry_name(floor_entry) or _entry_name(area_entry) or "L").replace(" ", "")


def _normalise_bay_name(labels: list[Any], extra_texts: list[str]) -> str:
    """Return compact bay text such as B7 or S014."""
    import re

    candidates = [_entry_name(label) or getattr(label, "label_id", "") for label in labels]
    candidates.extend(extra_texts)
    for text in candidates:
        match = re.search(r"\bbay\s*([A-Za-z0-9-]+)", text, re.IGNORECASE)
        if match:
            return f"B{match.group(1)}"
        match = re.search(r"\bb\s*([0-9][A-Za-z0-9-]*)", text, re.IGNORECASE)
        if match:
            return f"B{match.group(1)}"
        match = re.search(r"\b(?:spot|space)\s*([A-Za-z0-9-]+)", text, re.IGNORECASE)
        if match:
            return f"S{match.group(1)}"
        match = re.search(r"\bs\s*([0-9][A-Za-z0-9-]*)", text, re.IGNORECASE)
        if match:
            return f"S{match.group(1)}"
    return ""


def _suffix_for_entity(entity_id: str, entity_entry: Any, state: Any) -> str:
    """Return the outlet entity suffix based on domain, class, unit, and name."""
    domain = entity_id.split(".", 1)[0]
    if domain == "switch":
        return "Control"
    if domain != "sensor":
        return ""

    attributes = getattr(state, "attributes", {}) if state is not None else {}
    device_class = attributes.get("device_class") or getattr(entity_entry, "device_class", None)
    unit = attributes.get("unit_of_measurement", "")
    name_text = " ".join(
        str(item or "")
        for item in [
            attributes.get("friendly_name"),
            getattr(entity_entry, "name", None),
            getattr(entity_entry, "original_name", None),
            entity_id,
        ]
    ).lower()

    if device_class == "power" or unit in {"W", "kW"}:
        return "Watts"
    if device_class == "current" or unit == "A" or "current" in name_text or "amp" in name_text:
        return "Amps"
    if device_class == "voltage" or unit == "V" or "voltage" in name_text:
        return "Voltage"
    if device_class == "energy" or unit in {"Wh", "kWh"}:
        if "total daily" in name_text or "daily energy" in name_text:
            return "Daily Wh"
        return "Wh"
    if "power factor" in name_text:
        return "Power Factor"
    return ""


def _is_managed_switch(entity_id: str, entity_entry: Any, state: Any, entity_filter: str) -> bool:
    """Return true if the switch looks like a controllable POW outlet."""
    attributes = getattr(state, "attributes", {}) if state is not None else {}
    haystack = " ".join(
        str(item or "")
        for item in [
            entity_id,
            attributes.get("friendly_name"),
            getattr(entity_entry, "original_name", None),
            getattr(entity_entry, "name", None),
        ]
    ).lower()
    keywords = [item.strip().lower() for item in entity_filter.split(",") if item.strip()]
    return (
        entity_id.startswith("switch.")
        and not any(word in haystack for word in ("restart", "reboot", "firmware", "update"))
        and (not keywords or any(keyword in haystack for keyword in keywords))
    )


def _build_auto_name_plan(
    hass: HomeAssistant,
    *,
    entity_filter: str,
) -> list[dict[str, Any]]:
    """Build proposed entity display names from HA area/floor/label metadata."""
    entity_registry = er.async_get(hass)
    device_registry = dr.async_get(hass)
    area_registry = ar.async_get(hass)
    floor_registry = fr.async_get(hass)
    label_registry = lr.async_get(hass)

    entries = list(getattr(entity_registry, "entities", {}).values())
    managed_device_ids = {
        getattr(entry, "device_id", None)
        for entry in entries
        if _is_managed_switch(entry.entity_id, entry, hass.states.get(entry.entity_id), entity_filter)
    }
    managed_device_ids.discard(None)

    plan = []
    for entry in entries:
        device_id = getattr(entry, "device_id", None)
        if device_id not in managed_device_ids or entry.entity_id.split(".", 1)[0] not in {"switch", "sensor"}:
            continue

        state = hass.states.get(entry.entity_id)
        if entry.entity_id.startswith("switch.") and not _is_managed_switch(entry.entity_id, entry, state, entity_filter):
            continue

        device_entry = _registry_get(device_registry, "devices", device_id)
        area_entry = _area_for_entity(entry, device_entry, area_registry)
        floor_entry = _floor_for_area(area_entry, floor_registry)
        label_ids = [
            *(getattr(entry, "labels", []) or []),
            *(getattr(device_entry, "labels", []) or []),
            *(getattr(area_entry, "labels", []) or []),
        ]
        labels = _label_entries(label_registry, list(dict.fromkeys(label_ids)))
        state_name = state.attributes.get("friendly_name", "") if state else ""
        extra_texts = [
            state_name,
            getattr(entry, "name", None) or "",
            getattr(entry, "original_name", None) or "",
            getattr(device_entry, "name_by_user", None) or "",
            getattr(device_entry, "name", None) or "",
            entry.entity_id,
        ]
        level = _normalise_level_name(floor_entry, area_entry, labels, extra_texts)
        bay = _normalise_bay_name(labels, extra_texts)
        if not bay:
            continue

        suffix = _suffix_for_entity(entry.entity_id, entry, state)
        if not suffix:
            continue
        proposed = f"{level}-{bay} {suffix}"
        current = getattr(entry, "name", None) or (state.attributes.get("friendly_name") if state else entry.entity_id)
        plan.append(
            {
                "entity_id": entry.entity_id,
                "current_name": current,
                "proposed_name": proposed,
                "area": _entry_name(area_entry),
                "floor": _entry_name(floor_entry),
                "labels": [_entry_name(label) for label in labels],
                "changed": current != proposed,
            }
        )

    return sorted(plan, key=lambda item: item["proposed_name"])


@websocket_api.websocket_command(
    {
        vol.Required("type"): "pow_reporting/auto_name_entities",
        vol.Optional("apply", default=False): cv.boolean,
        vol.Optional("entity_filter", default=DEFAULT_ENTITY_FILTER): cv.string,
    }
)
@websocket_api.async_response
async def _websocket_auto_name_entities(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Preview or apply HA entity display names from area/floor/bay labels."""
    plan = _build_auto_name_plan(hass, entity_filter=msg["entity_filter"])

    if msg["apply"]:
        entity_registry = er.async_get(hass)
        for item in plan:
            if item["changed"]:
                entity_registry.async_update_entity(
                    item["entity_id"],
                    name=item["proposed_name"],
                )
        plan = _build_auto_name_plan(hass, entity_filter=msg["entity_filter"])

    connection.send_result(
        msg["id"],
        {
            "applied": msg["apply"],
            "entities": plan,
            "changed_count": sum(1 for item in plan if item["changed"]),
        },
    )


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload the dashboard panel."""
    options = {**entry.data, **entry.options}
    frontend.async_remove_panel(hass, options.get(CONF_URL_PATH, DEFAULT_URL_PATH))
    return True


async def _async_update_listener(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Reload the entry when options change."""
    await hass.config_entries.async_reload(entry.entry_id)
