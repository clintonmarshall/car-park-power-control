"""Live Home Assistant entity coordinator for ParkPower sessions."""

from __future__ import annotations

from collections.abc import Callable
import logging
from typing import Any

from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.helpers.event import async_track_state_change_event

from .const import CONF_ENTITY_FILTER, DEFAULT_ENTITY_FILTER
from .outlet_registry import OutletMapping, discover_outlets, read_numeric_state
from .websocket import async_load_session_manager, async_save_session_manager

_LOGGER = logging.getLogger(__name__)


class PowReportingCoordinator:
    """Listen to live outlet meter state and advance charging sessions."""

    def __init__(self, hass: HomeAssistant, options: dict[str, Any]) -> None:
        """Initialize the coordinator."""
        self.hass = hass
        self.options = options
        self.outlets: dict[str, OutletMapping] = {}
        self.sensor_to_outlet: dict[str, str] = {}
        self._unsub: list[Callable[[], None]] = []

    async def async_start(self) -> None:
        """Discover entities and subscribe to state changes."""
        self.async_stop()
        self.async_refresh_mappings()
        entity_ids = sorted({*self.sensor_to_outlet, *self.outlets})
        if not entity_ids:
            _LOGGER.debug("No ParkPower outlet entities discovered for live session tracking")
            return
        self._unsub.append(
            async_track_state_change_event(
                self.hass,
                entity_ids,
                self._state_changed,
            )
        )
        _LOGGER.debug("Tracking %s ParkPower entities for live session updates", len(entity_ids))

    def async_stop(self) -> None:
        """Stop all listeners."""
        while self._unsub:
            self._unsub.pop()()

    def async_refresh_mappings(self) -> None:
        """Refresh outlet/sensor mappings from Home Assistant registries."""
        entity_filter = self.options.get(CONF_ENTITY_FILTER, DEFAULT_ENTITY_FILTER)
        self.outlets = discover_outlets(self.hass, entity_filter=entity_filter)
        self.sensor_to_outlet = {}
        for outlet in self.outlets.values():
            if outlet.power_entity_id:
                self.sensor_to_outlet[outlet.power_entity_id] = outlet.switch_entity_id
            if outlet.energy_entity_id:
                self.sensor_to_outlet[outlet.energy_entity_id] = outlet.switch_entity_id

    @callback
    def _state_changed(self, event: Event) -> None:
        """Handle a Home Assistant state_changed event."""
        entity_id = event.data.get("entity_id")
        if entity_id in self.sensor_to_outlet:
            self.hass.async_create_task(self._async_update_from_sensor(entity_id))
            return
        if entity_id in self.outlets:
            self.hass.async_create_task(self._async_update_from_switch(entity_id))

    async def _async_update_from_sensor(self, entity_id: str) -> None:
        """Advance a session from a power or energy sensor update."""
        outlet_entity_id = self.sensor_to_outlet.get(entity_id)
        if outlet_entity_id is None:
            return
        outlet = self.outlets.get(outlet_entity_id)
        if outlet is None:
            return

        power_watts = read_numeric_state(self.hass, outlet.power_entity_id)
        meter_reading = read_numeric_state(self.hass, outlet.energy_entity_id)
        manager = await async_load_session_manager(self.hass)
        session = manager.update_measurement(
            outlet_entity_id=outlet_entity_id,
            power_watts=power_watts,
            meter_reading=meter_reading,
        )
        if session is not None:
            await async_save_session_manager(self.hass, manager)

    async def _async_update_from_switch(self, switch_entity_id: str) -> None:
        """Complete an active session when a tracked switch is turned off externally."""
        state = self.hass.states.get(switch_entity_id)
        if state is None or state.state != "off":
            return
        outlet = self.outlets.get(switch_entity_id)
        meter_reading = read_numeric_state(self.hass, outlet.energy_entity_id) if outlet else None
        manager = await async_load_session_manager(self.hass)
        session = manager.complete_session(
            outlet_entity_id=switch_entity_id,
            reason="Relay switched off outside ParkPower",
            end_meter_reading=meter_reading,
        )
        if session is not None:
            await async_save_session_manager(self.hass, manager)
