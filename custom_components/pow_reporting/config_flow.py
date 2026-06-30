"""Config flow for Adaptive Services ParkPower."""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant import config_entries
from homeassistant.data_entry_flow import FlowResult

from .const import (
    CONF_CHARGING_START_DELAY_SECONDS,
    CONF_CHARGING_START_WATTS,
    CONF_CHARGING_STOP_DELAY_MINUTES,
    CONF_CHARGING_STOP_WATTS,
    CONF_DASHBOARD_NAME,
    CONF_ENTITY_FILTER,
    CONF_ENABLE_CUSTOMER_PORTAL,
    CONF_LOGO_URL,
    CONF_MAXIMUM_SESSION_HOURS,
    CONF_METER_STALE_MINUTES,
    CONF_OFFLINE_TIMEOUT_MINUTES,
    CONF_PORTAL_NAME,
    CONF_PORTAL_URL_PATH,
    CONF_PUBLIC_PORT,
    CONF_SIDEBAR_ICON,
    CONF_URL_PATH,
    DEFAULT_DASHBOARD_NAME,
    DEFAULT_ENTITY_FILTER,
    DEFAULT_PORTAL_NAME,
    DEFAULT_PORTAL_URL_PATH,
    DEFAULT_PUBLIC_PORT,
    DEFAULT_SESSION_THRESHOLDS,
    DEFAULT_SIDEBAR_ICON,
    DEFAULT_URL_PATH,
    DOMAIN,
)


def _schema(defaults: dict[str, Any]) -> vol.Schema:
    """Return the setup/options schema."""
    return vol.Schema(
        {
            vol.Required(
                CONF_DASHBOARD_NAME,
                default=defaults.get(CONF_DASHBOARD_NAME, DEFAULT_DASHBOARD_NAME),
            ): str,
            vol.Required(
                CONF_URL_PATH,
                default=defaults.get(CONF_URL_PATH, DEFAULT_URL_PATH),
            ): str,
            vol.Required(
                CONF_SIDEBAR_ICON,
                default=defaults.get(CONF_SIDEBAR_ICON, DEFAULT_SIDEBAR_ICON),
            ): str,
            vol.Optional(
                CONF_LOGO_URL,
                default=defaults.get(CONF_LOGO_URL, ""),
            ): str,
            vol.Optional(
                CONF_ENTITY_FILTER,
                default=defaults.get(CONF_ENTITY_FILTER, DEFAULT_ENTITY_FILTER),
            ): str,
            vol.Optional(
                CONF_ENABLE_CUSTOMER_PORTAL,
                default=defaults.get(CONF_ENABLE_CUSTOMER_PORTAL, True),
            ): bool,
            vol.Optional(
                CONF_PORTAL_NAME,
                default=defaults.get(CONF_PORTAL_NAME, DEFAULT_PORTAL_NAME),
            ): str,
            vol.Optional(
                CONF_PORTAL_URL_PATH,
                default=defaults.get(CONF_PORTAL_URL_PATH, DEFAULT_PORTAL_URL_PATH),
            ): str,
            vol.Optional(
                CONF_PUBLIC_PORT,
                default=defaults.get(CONF_PUBLIC_PORT, DEFAULT_PUBLIC_PORT),
            ): int,
            vol.Optional(
                CONF_CHARGING_START_WATTS,
                default=defaults.get(
                    CONF_CHARGING_START_WATTS,
                    DEFAULT_SESSION_THRESHOLDS[CONF_CHARGING_START_WATTS],
                ),
            ): vol.Coerce(float),
            vol.Optional(
                CONF_CHARGING_START_DELAY_SECONDS,
                default=defaults.get(
                    CONF_CHARGING_START_DELAY_SECONDS,
                    DEFAULT_SESSION_THRESHOLDS[CONF_CHARGING_START_DELAY_SECONDS],
                ),
            ): int,
            vol.Optional(
                CONF_CHARGING_STOP_WATTS,
                default=defaults.get(
                    CONF_CHARGING_STOP_WATTS,
                    DEFAULT_SESSION_THRESHOLDS[CONF_CHARGING_STOP_WATTS],
                ),
            ): vol.Coerce(float),
            vol.Optional(
                CONF_CHARGING_STOP_DELAY_MINUTES,
                default=defaults.get(
                    CONF_CHARGING_STOP_DELAY_MINUTES,
                    DEFAULT_SESSION_THRESHOLDS[CONF_CHARGING_STOP_DELAY_MINUTES],
                ),
            ): int,
            vol.Optional(
                CONF_MAXIMUM_SESSION_HOURS,
                default=defaults.get(
                    CONF_MAXIMUM_SESSION_HOURS,
                    DEFAULT_SESSION_THRESHOLDS[CONF_MAXIMUM_SESSION_HOURS],
                ),
            ): int,
            vol.Optional(
                CONF_METER_STALE_MINUTES,
                default=defaults.get(
                    CONF_METER_STALE_MINUTES,
                    DEFAULT_SESSION_THRESHOLDS[CONF_METER_STALE_MINUTES],
                ),
            ): int,
            vol.Optional(
                CONF_OFFLINE_TIMEOUT_MINUTES,
                default=defaults.get(
                    CONF_OFFLINE_TIMEOUT_MINUTES,
                    DEFAULT_SESSION_THRESHOLDS[CONF_OFFLINE_TIMEOUT_MINUTES],
                ),
            ): int,
        }
    )


class PowReportingConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a config flow."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        """Handle the initial setup step."""
        await self.async_set_unique_id(DOMAIN)
        self._abort_if_unique_id_configured()

        if user_input is not None:
            return self.async_create_entry(
                title=user_input[CONF_DASHBOARD_NAME],
                data=user_input,
            )

        return self.async_show_form(
            step_id="user",
            data_schema=_schema({}),
        )

    @staticmethod
    def async_get_options_flow(
        config_entry: config_entries.ConfigEntry,
    ) -> config_entries.OptionsFlow:
        """Return the options flow."""
        return PowReportingOptionsFlow(config_entry)


class PowReportingOptionsFlow(config_entries.OptionsFlow):
    """Handle options."""

    def __init__(self, config_entry: config_entries.ConfigEntry) -> None:
        """Initialize options flow."""
        self._config_entry = config_entry

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        """Manage options."""
        defaults = {**self._config_entry.data, **self._config_entry.options}

        if user_input is not None:
            return self.async_create_entry(title="", data=user_input)

        return self.async_show_form(
            step_id="init",
            data_schema=_schema(defaults),
        )
