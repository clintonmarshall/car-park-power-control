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
from homeassistant.helpers.storage import Store
import homeassistant.helpers.config_validation as cv

from .const import (
    CONF_DASHBOARD_NAME,
    CONF_ENTITY_FILTER,
    CONF_LOGO_URL,
    CONF_SIDEBAR_ICON,
    CONF_URL_PATH,
    DEFAULT_DASHBOARD_NAME,
    DEFAULT_ENTITY_FILTER,
    DEFAULT_SIDEBAR_ICON,
    DEFAULT_URL_PATH,
    DOMAIN,
    PANEL_JS_URL,
)

PLATFORMS: list[Platform] = []
STORAGE_KEY = f"{DOMAIN}.outlet_log"
STORAGE_VERSION = 1
MAX_LOG_ROWS = 2000

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
    return True


async def _async_register_dashboard(
    hass: HomeAssistant,
    options: dict[str, Any],
) -> None:
    """Register the reporting dashboard panel."""
    url_path = options.get(CONF_URL_PATH, DEFAULT_URL_PATH)
    sidebar_title = options.get(CONF_DASHBOARD_NAME, DEFAULT_DASHBOARD_NAME)
    sidebar_icon = options.get(CONF_SIDEBAR_ICON, DEFAULT_SIDEBAR_ICON)

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
            "logo_url": options.get(CONF_LOGO_URL, ""),
            "entity_filter": options.get(CONF_ENTITY_FILTER, DEFAULT_ENTITY_FILTER),
        },
    )


def _async_register_websocket_commands(hass: HomeAssistant) -> None:
    """Register websocket commands once."""
    if hass.data.setdefault(DOMAIN, {}).get("websocket_registered"):
        return

    websocket_api.async_register_command(hass, _websocket_get_outlet_log)
    websocket_api.async_register_command(hass, _websocket_control_outlet)
    websocket_api.async_register_command(hass, _websocket_all_off)
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
            events.append(
                await _async_log_outlet_event(
                    hass,
                    switch_entity_id=switch_entity_id,
                    action="turn_off",
                    reference=reference,
                    outlet_name=name,
                    success=True,
                )
            )
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


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload the dashboard panel."""
    options = {**entry.data, **entry.options}
    frontend.async_remove_panel(hass, options.get(CONF_URL_PATH, DEFAULT_URL_PATH))
    return True


async def _async_update_listener(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Reload the entry when options change."""
    await hass.config_entries.async_reload(entry.entry_id)
