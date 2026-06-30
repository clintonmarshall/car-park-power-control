"""Tests for ParkPower management reporting."""

from __future__ import annotations

from pathlib import Path
import sys
import types
from unittest import TestCase

PACKAGE_ROOT = Path(__file__).resolve().parents[1] / "custom_components" / "pow_reporting"
package = types.ModuleType("custom_components.pow_reporting")
package.__path__ = [str(PACKAGE_ROOT)]
sys.modules.setdefault("custom_components.pow_reporting", package)

from custom_components.pow_reporting.reporting import build_management_report


class ReportingTest(TestCase):
    """Validate Phase 4 reporting calculations."""

    def test_management_report_kpis_and_statement(self) -> None:
        """Completed sessions produce KPI and statement totals."""
        report = build_management_report(
            billing_report={
                "settings": {"currency": "AUD"},
                "active": [{"switch_entity_id": "switch.bay_1"}],
                "completed": [
                    {
                        "switch_entity_id": "switch.bay_1",
                        "outlet_name": "Bay 1",
                        "reference": "Smith",
                        "start_time": "2026-07-01T08:00:00+10:00",
                        "end_time": "2026-07-01T10:00:00+10:00",
                        "duration_seconds": 7200,
                        "energy_kwh": 4.5,
                        "cost": 1.8,
                        "currency": "AUD",
                    },
                    {
                        "switch_entity_id": "switch.bay_2",
                        "outlet_name": "Bay 2",
                        "reference": "Jones",
                        "start_time": "2026-07-01T09:00:00+10:00",
                        "end_time": "2026-07-01T11:00:00+10:00",
                        "duration_seconds": 3600,
                        "energy_kwh": 2.0,
                        "cost": 0.8,
                        "currency": "AUD",
                        "billing_status": "paid",
                    },
                ],
            },
            session_data={"sessions": [{"state": "waiting_for_load"}, {"state": "requires_review"}]},
            records={"customers": [], "vehicles": [], "user_groups": []},
            outlets=[
                {"id": "switch.bay_1", "name": "Bay 1", "state": "on", "power_w": 800},
                {"id": "switch.bay_2", "name": "Bay 2", "state": "off", "power_w": 0},
            ],
            filters={},
        )

        self.assertEqual(report["kpis"]["total_managed_outlets"], 2)
        self.assertEqual(report["kpis"]["active_charging_outlets"], 1)
        self.assertEqual(report["kpis"]["waiting_outlets"], 1)
        self.assertEqual(report["kpis"]["faulted_outlets"], 1)
        self.assertEqual(report["statement"]["total_measured_charging_energy"], 6.5)
        self.assertEqual(report["statement"]["total_recoverable_amount"], 2.6)
        self.assertEqual(report["statement"]["amount_marked_paid"], 0.8)
        self.assertEqual(report["charts"]["top_outlets"][0]["label"], "Bay 1")

    def test_reference_filter(self) -> None:
        """Reference filter narrows session rows."""
        report = build_management_report(
            billing_report={
                "settings": {"currency": "AUD"},
                "active": [],
                "completed": [
                    {"switch_entity_id": "switch.a", "reference": "Alpha", "end_time": "2026-07-01T10:00:00+10:00"},
                    {"switch_entity_id": "switch.b", "reference": "Beta", "end_time": "2026-07-01T10:00:00+10:00"},
                ],
            },
            session_data={"sessions": []},
            records={"customers": [], "vehicles": [], "user_groups": []},
            outlets=[],
            filters={"reference": "alp"},
        )

        self.assertEqual(len(report["sessions"]), 1)
        self.assertEqual(report["sessions"][0]["reference"], "Alpha")


if __name__ == "__main__":
    import unittest

    unittest.main()
