"""Session lifecycle management for ParkPower outlets."""

from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import uuid4

from .const import (
    CONF_CHARGING_START_DELAY_SECONDS,
    CONF_CHARGING_START_WATTS,
    CONF_CHARGING_STOP_DELAY_MINUTES,
    CONF_CHARGING_STOP_WATTS,
    DEFAULT_SESSION_THRESHOLDS,
)
from .models import (
    BillingState,
    ChargingSession,
    SessionEvent,
    SessionState,
    TERMINAL_SESSION_STATES,
    utc_now,
)


class SessionManager:
    """Manage charging-session state against a loaded storage payload."""

    def __init__(self, data: dict[str, Any]) -> None:
        """Initialize from storage data."""
        self.data = data
        self.thresholds = {**DEFAULT_SESSION_THRESHOLDS, **dict(data.get("thresholds") or {})}
        self.sessions = [
            ChargingSession.from_dict(session)
            for session in data.get("sessions", [])
            if isinstance(session, dict)
        ]
        self.active_sessions = dict(data.get("active_sessions") or {})

    def dump(self) -> dict[str, Any]:
        """Return storage data with the current manager state."""
        self.data["sessions"] = [session.as_dict() for session in self.sessions]
        self.data["active_sessions"] = {
            outlet: session_id
            for outlet, session_id in self.active_sessions.items()
            if self.get_session(session_id) is not None
        }
        self.data["thresholds"] = self.thresholds
        return self.data

    def get_session(self, session_id: str) -> ChargingSession | None:
        """Return a session by ID."""
        return next((session for session in self.sessions if session.session_id == session_id), None)

    def active_for_outlet(self, outlet_entity_id: str) -> ChargingSession | None:
        """Return the active session for an outlet, if any."""
        session_id = self.active_sessions.get(outlet_entity_id)
        if not session_id:
            return None
        session = self.get_session(session_id)
        if session is None or session.state in TERMINAL_SESSION_STATES:
            self.active_sessions.pop(outlet_entity_id, None)
            return None
        return session

    def start_session(
        self,
        *,
        outlet_entity_id: str,
        outlet_display_name: str,
        customer_reference: str,
        start_meter_reading: float | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> ChargingSession:
        """Create or return an active session when an outlet is energised."""
        existing = self.active_for_outlet(outlet_entity_id)
        if existing is not None:
            self.add_event(existing, "authorise_existing", note="Outlet already has an active session")
            return existing

        now = utc_now()
        metadata = metadata or {}
        session = ChargingSession(
            session_id=uuid4().hex,
            outlet_entity_id=outlet_entity_id,
            outlet_display_name=outlet_display_name,
            state=SessionState.WAITING_FOR_LOAD,
            site=str(metadata.get("site") or ""),
            level=str(metadata.get("level") or ""),
            area=str(metadata.get("area") or ""),
            bay=str(metadata.get("bay") or ""),
            customer_reference=customer_reference,
            customer_id=str(metadata.get("customer_id") or ""),
            vehicle_id=str(metadata.get("vehicle_id") or ""),
            user_group=str(metadata.get("user_group") or ""),
            start_timestamp=now,
            start_meter_reading=start_meter_reading,
            last_meter_reading=start_meter_reading,
            last_meter_timestamp=now if start_meter_reading is not None else "",
        )
        self.add_event(session, "authorised", to_state=session.state.value, note="Relay energised; waiting for load")
        self.sessions.append(session)
        self.active_sessions[outlet_entity_id] = session.session_id
        return session

    def complete_session(
        self,
        *,
        outlet_entity_id: str,
        reason: str,
        end_meter_reading: float | None = None,
    ) -> ChargingSession | None:
        """Complete the active session for an outlet."""
        session = self.active_for_outlet(outlet_entity_id)
        if session is None:
            return None
        self._finish_session(session, SessionState.COMPLETED, reason, end_meter_reading)
        return session

    def cancel_session(self, session_id: str, reason: str) -> ChargingSession | None:
        """Cancel a session by ID."""
        session = self.get_session(session_id)
        if session is None:
            return None
        self._finish_session(session, SessionState.CANCELLED, reason, session.last_meter_reading)
        return session

    def annotate_session(self, session_id: str, note: str) -> ChargingSession | None:
        """Add an administrator note to a session timeline."""
        session = self.get_session(session_id)
        if session is None:
            return None
        self.add_event(session, "annotated", note=note)
        return session

    def correct_session(self, session_id: str, fields: dict[str, Any], reason: str) -> ChargingSession | None:
        """Apply a small manual correction and record the adjustment."""
        session = self.get_session(session_id)
        if session is None:
            return None
        allowed = {
            "customer_reference",
            "customer_id",
            "vehicle_id",
            "user_group",
            "site",
            "level",
            "area",
            "bay",
            "billing_status",
            "energy_consumed_kwh",
        }
        changes = {key: value for key, value in fields.items() if key in allowed}
        applied = {}
        for key, value in changes.items():
            if key == "billing_status":
                try:
                    value = BillingState(value)
                except ValueError:
                    continue
            setattr(session, key, value)
            applied[key] = value.value if isinstance(value, BillingState) else value
        session.adjustment_history.append(
            {
                "time": utc_now(),
                "reason": reason,
                "fields": applied,
            }
        )
        self.add_event(session, "corrected", reason=reason, data={"fields": applied})
        return session

    def update_measurement(
        self,
        *,
        outlet_entity_id: str,
        power_watts: float | None,
        meter_reading: float | None,
        at: datetime | None = None,
    ) -> ChargingSession | None:
        """Update an active session from observed power and energy values."""
        session = self.active_for_outlet(outlet_entity_id)
        if session is None:
            return None

        now_dt = at or datetime.now().astimezone()
        now = now_dt.isoformat(timespec="seconds")
        if meter_reading is not None:
            if session.last_meter_reading is not None and meter_reading < session.last_meter_reading:
                self.transition(session, SessionState.REQUIRES_REVIEW, "energy_meter_rollback")
            session.last_meter_reading = meter_reading
            session.last_meter_timestamp = now

        session.last_power_watts = power_watts
        if power_watts is None:
            return session

        start_watts = float(self.thresholds[CONF_CHARGING_START_WATTS])
        stop_watts = float(self.thresholds[CONF_CHARGING_STOP_WATTS])
        if power_watts >= start_watts:
            session.below_threshold_since = ""
            if not session.above_threshold_since:
                session.above_threshold_since = now
            if session.state in {SessionState.WAITING_FOR_LOAD, SessionState.AUTHORISED}:
                first_seen = _parse_time(session.above_threshold_since)
                delay = int(self.thresholds[CONF_CHARGING_START_DELAY_SECONDS])
                if first_seen and (now_dt - first_seen).total_seconds() >= delay:
                    session.charging_start_timestamp = session.charging_start_timestamp or now
                    self.transition(session, SessionState.CHARGING, "load_detected")
            elif session.state == SessionState.IDLE_GRACE_PERIOD:
                self.transition(session, SessionState.CHARGING, "load_resumed")
            return session

        session.above_threshold_since = ""
        if session.state == SessionState.CHARGING and power_watts <= stop_watts:
            session.below_threshold_since = session.below_threshold_since or now
            self.transition(session, SessionState.IDLE_GRACE_PERIOD, "load_below_stop_threshold")
            return session

        if session.state == SessionState.IDLE_GRACE_PERIOD and power_watts <= stop_watts:
            first_seen = _parse_time(session.below_threshold_since)
            delay_seconds = int(float(self.thresholds[CONF_CHARGING_STOP_DELAY_MINUTES]) * 60)
            if first_seen and (now_dt - first_seen).total_seconds() >= delay_seconds:
                self._finish_session(session, SessionState.COMPLETED, "idle_grace_period_elapsed", meter_reading)
        return session

    def transition(self, session: ChargingSession, to_state: SessionState, reason: str) -> None:
        """Move a session to a new state and record the transition."""
        if session.state == to_state:
            return
        from_state = session.state
        session.state = to_state
        self.add_event(
            session,
            "state_changed",
            from_state=from_state.value,
            to_state=to_state.value,
            reason=reason,
        )

    def add_event(
        self,
        session: ChargingSession,
        event: str,
        *,
        from_state: str | None = None,
        to_state: str | None = None,
        reason: str = "",
        note: str = "",
        data: dict[str, Any] | None = None,
    ) -> None:
        """Append a session timeline event."""
        session.session_event_timeline.append(
            SessionEvent(
                time=utc_now(),
                event=event,
                from_state=from_state,
                to_state=to_state,
                reason=reason,
                note=note,
                data=data or {},
            ).as_dict()
        )

    def _finish_session(
        self,
        session: ChargingSession,
        state: SessionState,
        reason: str,
        meter_reading: float | None,
    ) -> None:
        now = utc_now()
        session.end_timestamp = now
        session.end_meter_reading = meter_reading
        if meter_reading is not None and session.start_meter_reading is not None:
            session.energy_consumed_kwh = max(0.0, meter_reading - session.start_meter_reading)
        session.completion_reason = reason
        self.transition(session, state, reason)
        self.active_sessions.pop(session.outlet_entity_id, None)


def _parse_time(value: str) -> datetime | None:
    """Parse an ISO timestamp safely."""
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None
