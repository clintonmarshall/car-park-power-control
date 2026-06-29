"""Config flow for Adaptive Services ParkPower."""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant import config_entries
from homeassistant.data_entry_flow import FlowResult

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
