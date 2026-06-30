"""Tests for ParkPower session lifecycle rules."""

from __future__ import annotations

from datetime import datetime, timedelta
from pathlib import Path
import sys
import types
from unittest import TestCase

PACKAGE_ROOT = Path(__file__).resolve().parents[1] / "custom_components" / "pow_reporting"
package = types.ModuleType("custom_components.pow_reporting")
package.__path__ = [str(PACKAGE_ROOT)]
sys.modules.setdefault("custom_components.pow_reporting", package)

from custom_components.pow_reporting.const import (
    CONF_CHARGING_START_DELAY_SECONDS,
    CONF_CHARGING_START_WATTS,
    CONF_CHARGING_STOP_DELAY_MINUTES,
    CONF_CHARGING_STOP_WATTS,
    DEFAULT_SESSION_THRESHOLDS,
)
from custom_components.pow_reporting.models import SessionState
from custom_components.pow_reporting.session_manager import SessionManager


class SessionManagerTest(TestCase):
    """Validate deterministic session transitions."""

    def _manager(self) -> SessionManager:
        data = {
            "sessions": [],
            "active_sessions": {},
            "thresholds": {
                **DEFAULT_SESSION_THRESHOLDS,
                CONF_CHARGING_START_WATTS: 100.0,
                CONF_CHARGING_START_DELAY_SECONDS: 30,
                CONF_CHARGING_STOP_WATTS: 50.0,
                CONF_CHARGING_STOP_DELAY_MINUTES: 10,
            },
        }
        return SessionManager(data)

    def test_start_session_waits_for_load(self) -> None:
        """Energising a relay does not immediately mean charging."""
        manager = self._manager()
        session = manager.start_session(
            outlet_entity_id="switch.bay_1",
            outlet_display_name="Bay 1",
            customer_reference="Bay 1 - Test",
            start_meter_reading=10.0,
        )

        self.assertEqual(session.state, SessionState.WAITING_FOR_LOAD)
        self.assertEqual(manager.active_for_outlet("switch.bay_1"), session)
        self.assertEqual(session.start_meter_reading, 10.0)

    def test_delayed_load_detection_starts_charging(self) -> None:
        """Power must stay above the start threshold for the configured delay."""
        manager = self._manager()
        manager.start_session(
            outlet_entity_id="switch.bay_1",
            outlet_display_name="Bay 1",
            customer_reference="Bay 1 - Test",
        )
        now = datetime.fromisoformat("2026-07-01T10:00:00+10:00")

        session = manager.update_measurement(
            outlet_entity_id="switch.bay_1",
            power_watts=140.0,
            meter_reading=10.0,
            at=now,
        )
        self.assertEqual(session.state, SessionState.WAITING_FOR_LOAD)

        session = manager.update_measurement(
            outlet_entity_id="switch.bay_1",
            power_watts=140.0,
            meter_reading=10.1,
            at=now + timedelta(seconds=31),
        )
        self.assertEqual(session.state, SessionState.CHARGING)
        self.assertTrue(session.charging_start_timestamp)

    def test_delayed_stop_completes_session(self) -> None:
        """Low power starts a grace period before completion."""
        manager = self._manager()
        manager.start_session(
            outlet_entity_id="switch.bay_1",
            outlet_display_name="Bay 1",
            customer_reference="Bay 1 - Test",
            start_meter_reading=10.0,
        )
        now = datetime.fromisoformat("2026-07-01T10:00:00+10:00")
        manager.update_measurement(
            outlet_entity_id="switch.bay_1",
            power_watts=140.0,
            meter_reading=10.0,
            at=now,
        )
        session = manager.update_measurement(
            outlet_entity_id="switch.bay_1",
            power_watts=140.0,
            meter_reading=10.4,
            at=now + timedelta(seconds=31),
        )
        self.assertEqual(session.state, SessionState.CHARGING)

        session = manager.update_measurement(
            outlet_entity_id="switch.bay_1",
            power_watts=20.0,
            meter_reading=10.8,
            at=now + timedelta(minutes=20),
        )
        self.assertEqual(session.state, SessionState.IDLE_GRACE_PERIOD)

        session = manager.update_measurement(
            outlet_entity_id="switch.bay_1",
            power_watts=20.0,
            meter_reading=11.0,
            at=now + timedelta(minutes=31),
        )
        self.assertEqual(session.state, SessionState.COMPLETED)
        self.assertEqual(session.energy_consumed_kwh, 1.0)
        self.assertIsNone(manager.active_for_outlet("switch.bay_1"))

    def test_meter_rollback_requires_review(self) -> None:
        """A lower energy counter value marks the session for review."""
        manager = self._manager()
        session = manager.start_session(
            outlet_entity_id="switch.bay_1",
            outlet_display_name="Bay 1",
            customer_reference="Bay 1 - Test",
            start_meter_reading=10.0,
        )
        manager.update_measurement(
            outlet_entity_id="switch.bay_1",
            power_watts=120.0,
            meter_reading=9.8,
            at=datetime.fromisoformat("2026-07-01T10:00:00+10:00"),
        )

        self.assertEqual(session.state, SessionState.REQUIRES_REVIEW)


if __name__ == "__main__":
    import unittest

    unittest.main()
