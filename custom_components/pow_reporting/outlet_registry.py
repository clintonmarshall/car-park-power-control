"""Outlet and meter discovery helpers for ParkPower."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from homeassistant.core import HomeAssistant, State
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er

from .const import DEFAULT_ENTITY_FILTER

POWER_UNITS = {"W", "kW"}
ENERGY_UNITS = {"Wh", "kWh"}


@dataclass(slots=True)
class OutletMapping:
    """Matched Home Assistant entities for one controllable outlet."""

    switch_entity_id: str
    switch_name: str
    power_entity_id: str = ""
    energy_entity_id: str = ""
    device_id: str = ""


def discover_outlets(
    hass: HomeAssistant,
    *,
    entity_filter: str = DEFAULT_ENTITY_FILTER,
) -> dict[str, OutletMapping]:
    """Discover outlet switches and their matching power/energy sensors."""
    entity_registry = er.async_get(hass)
    device_registry = dr.async_get(hass)
    keywords = _keywords(entity_filter)

    sensor_rows: list[tuple[State, er.RegistryEntry, str, bool, bool]] = []
    for state in hass.states.async_all("sensor"):
        registry_entry = entity_registry.async_get(state.entity_id)
        if registry_entry is None:
            continue
        haystack = _entity_haystack(state, registry_entry, device_registry)
        if keywords and not any(keyword in haystack for keyword in keywords):
            continue
        is_power = _is_power_sensor(state)
        is_energy = _is_energy_sensor(state)
        if is_power or is_energy:
            sensor_rows.append((state, registry_entry, haystack, is_power, is_energy))

    mappings: dict[str, OutletMapping] = {}
    for state in hass.states.async_all("switch"):
        registry_entry = entity_registry.async_get(state.entity_id)
        if registry_entry is None:
            continue
        haystack = _entity_haystack(state, registry_entry, device_registry)
        if keywords and not any(keyword in haystack for keyword in keywords):
            continue
        if not _is_control_switch(haystack):
            continue

        device_id = registry_entry.device_id or ""
        power = next(
            (
                row_state.entity_id
                for row_state, row_registry, _row_haystack, is_power, _is_energy in sensor_rows
                if is_power and row_registry.device_id == device_id
            ),
            "",
        )
        energy = next(
            (
                row_state.entity_id
                for row_state, row_registry, _row_haystack, _is_power, is_energy in sensor_rows
                if is_energy and row_registry.device_id == device_id
            ),
            "",
        )
        mappings[state.entity_id] = OutletMapping(
            switch_entity_id=state.entity_id,
            switch_name=state.attributes.get("friendly_name", state.entity_id),
            power_entity_id=power,
            energy_entity_id=energy,
            device_id=device_id,
        )

    return mappings


def read_numeric_state(hass: HomeAssistant, entity_id: str) -> float | None:
    """Read a numeric state, normalising Wh to kWh and kW to W by unit type."""
    if not entity_id:
        return None
    state = hass.states.get(entity_id)
    if state is None:
        return None
    try:
        value = float(state.state)
    except (TypeError, ValueError):
        return None

    unit = state.attributes.get("unit_of_measurement")
    if unit == "Wh":
        return value / 1000
    if unit == "kW":
        return value * 1000
    return value


def _keywords(entity_filter: str) -> list[str]:
    """Return lowercase discovery keywords."""
    return [item.strip().lower() for item in entity_filter.split(",") if item.strip()]


def _entity_haystack(
    state: State,
    registry_entry: er.RegistryEntry,
    device_registry: dr.DeviceRegistry,
) -> str:
    """Build searchable metadata for an entity."""
    device = device_registry.async_get(registry_entry.device_id) if registry_entry.device_id else None
    values: list[Any] = [
        state.entity_id,
        state.attributes.get("friendly_name"),
        registry_entry.original_name,
        registry_entry.name,
    ]
    if device is not None:
        values.extend(
            [
                device.name_by_user,
                device.name,
                device.model,
                device.manufacturer,
            ]
        )
    return " ".join(str(value) for value in values if value).lower()


def _is_power_sensor(state: State) -> bool:
    """Return true when an entity looks like a power sensor."""
    return state.attributes.get("device_class") == "power" or state.attributes.get("unit_of_measurement") in POWER_UNITS


def _is_energy_sensor(state: State) -> bool:
    """Return true when an entity looks like an energy sensor."""
    return state.attributes.get("device_class") == "energy" or state.attributes.get("unit_of_measurement") in ENERGY_UNITS


def _is_control_switch(haystack: str) -> bool:
    """Exclude maintenance switches from outlet control."""
    return not any(token in haystack for token in ("restart", "update", "firmware", "reboot"))
