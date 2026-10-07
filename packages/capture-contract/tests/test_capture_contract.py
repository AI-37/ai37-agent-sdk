"""Контракт захвата: что принимают модели и что из них следует.

Пакет — единственное место, где агент и рендереры договариваются о форме ответа. Ломается он
незаметно: рендерер вне кластера просто начнёт отдавать то, что агент прочитает не так.
"""

from __future__ import annotations

import base64
from datetime import UTC, datetime
from typing import Any

import pytest
from pydantic import ValidationError

import ai37_capture_contract as contract
from ai37_capture_contract import (
    PRICE_HINTS_JS,
    CaptureBatchItem,
    CaptureBatchRequest,
    CaptureBatchResponse,
    CaptureResponse,
    CaptureStatus,
    RemoteCaptureBatchResponse,
    RemoteCaptureResponse,
    RendererHealth,
    RendererKind,
    RendererState,
    ScreenshotRole,
)

PNG = base64.b64encode(b"\x89PNG\r\n\x1a\n").decode()
NOW = datetime(2026, 10, 6, 12, 0, tzinfo=UTC)


def remote_result(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "captured_at": NOW.isoformat(),
        "final_url": "https://www.vseinstrumenti.ru/p/1",
        "title": "Перфоратор",
        "status": "OK",
        "screenshots": [
            {"role": "full_page", "width": 1440, "height": 5200, "device_scale_factor": 2, "png_base64": PNG},
            {"role": "viewport", "width": 1440, "height": 1000, "device_scale_factor": 2, "png_base64": PNG},
        ],
        "price_hints": [{"text": "12 990 ₽", "x": 900, "y": 410, "w": 160, "h": 40, "font_size": 32}],
        "title_bottom": 380,
        "page_region": "Тюмень",
        "proxy": "tmn-user1",
    }
    body.update(overrides)
    return body


def test_everything_in_all_is_importable() -> None:
    assert all(hasattr(contract, name) for name in contract.__all__)


class TestBatchRequest:
    def test_card_request_carries_the_batch_settings_without_a_second_warm_up(self) -> None:
        """Сессия пачки уже прогрета — второй заход на главную был бы лишним стуком в домен."""
        batch = CaptureBatchRequest(
            items=[CaptureBatchItem(url="https://etm.ru/p/1", ksr_code="07.4.03.06-0001", expected_article="A-1")],
            region="Тюмень",
            allowed_hosts=["etm.ru"],
            card_budget_seconds=60,
        )

        card = batch.card_request(batch.items[0])

        assert card.url == "https://etm.ru/p/1"
        assert card.expected_article == "A-1"
        assert card.allowed_hosts == ["etm.ru"]
        assert card.time_budget_seconds == 60
        assert card.warm_up_home is False

    def test_empty_batch_is_rejected(self) -> None:
        with pytest.raises(ValidationError):
            CaptureBatchRequest(items=[])


class TestRemoteResponse:
    def test_slot_answer_validates_with_bytes_in_the_body(self) -> None:
        batch = RemoteCaptureBatchResponse.model_validate({"results": [remote_result()], "proxy": "tmn-user1"})

        (result,) = batch.results
        assert isinstance(result, RemoteCaptureResponse)
        assert result.status is CaptureStatus.OK
        assert [s.role for s in result.screenshots] == [ScreenshotRole.FULL_PAGE, ScreenshotRole.VIEWPORT]
        assert base64.b64decode(result.screenshots[0].png_base64).startswith(b"\x89PNG")
        assert result.price_hints[0].text == "12 990 ₽"

    def test_remote_shot_needs_no_bucket_fields(self) -> None:
        """Ключа, хэша и размера у рендерера нет: их даёт бакет, а пишет туда агент."""
        shot = RemoteCaptureResponse.model_validate(remote_result()).screenshots[0]

        assert not hasattr(shot, "storage_key")
        assert not hasattr(shot, "sha256")

    def test_remote_shot_without_bytes_is_rejected(self) -> None:
        body = remote_result(screenshots=[{"role": "full_page", "width": 1, "height": 1, "device_scale_factor": 1}])

        with pytest.raises(ValidationError):
            RemoteCaptureResponse.model_validate(body)

    def test_bucket_answer_does_not_pass_for_a_remote_one_and_back(self) -> None:
        """Две формы снимков не взаимозаменяемы: перепутать их значит потерять либо байты, либо ключ."""
        with pytest.raises(ValidationError):
            CaptureResponse.model_validate(remote_result())

    def test_failure_without_screenshots_is_a_normal_answer(self) -> None:
        result = RemoteCaptureResponse.model_validate(
            remote_result(
                status="CAPTCHA_DETECTED", reason_code=contract.REASON_SITE_BLOCKED, screenshots=[], price_hints=[]
            )
        )

        assert result.reason_code == "SITE_BLOCKED"
        assert result.screenshots == []

    def test_unknown_status_is_rejected(self) -> None:
        with pytest.raises(ValidationError):
            RemoteCaptureResponse.model_validate(remote_result(status="CAPTURED"))


class TestBucketResponse:
    def test_browser_worker_answer_still_validates(self) -> None:
        shot = {
            "role": "full_page",
            "storage_key": "captures/2026-10-06/x/etm.ru/s1/full_page.png",
            "sha256": "0" * 64,
            "width": 1440,
            "height": 5200,
            "device_scale_factor": 1,
            "byte_size": 1024,
        }
        batch = CaptureBatchResponse.model_validate(
            {
                "results": [
                    {
                        "captured_at": NOW.isoformat(),
                        "final_url": None,
                        "title": None,
                        "status": "OK",
                        "screenshots": [shot],
                    }
                ]
            }
        )

        assert batch.results[0].screenshots[0].storage_key.endswith("full_page.png")


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("REASON_EXIT_BLOCKED", "EXIT_BLOCKED"),
        ("REASON_DOMAIN_COOLDOWN", "DOMAIN_COOLDOWN"),
        ("REASON_REGION_MISMATCH", "REGION_MISMATCH"),
        ("REASON_NOT_FOUND", "NOT_FOUND"),
        ("REASON_SITE_BLOCKED", "SITE_BLOCKED"),
        ("REASON_RENDERER_UNAVAILABLE", "RENDERER_UNAVAILABLE"),
        ("REASON_HOME_UNREACHABLE", "HOME_UNREACHABLE"),
        ("REASON_HOST_NOT_ALLOWED", "HOST_NOT_ALLOWED"),
    ],
)
def test_reason_codes_are_stable_strings(name: str, value: str) -> None:
    """Код уезжает в БД и на дашборд: переименование значения — это поломка контракта."""
    assert getattr(contract, name) == value


class TestHealth:
    def test_browser_worker_health_reads_as_headless(self) -> None:
        """Форма `/health` browser-worker как есть, с лишними полями проб и ёмкости."""
        health = RendererHealth.model_validate(
            {
                "status": "ok",
                "browser": True,
                "proxies": ["tmn-user1", "tmn-user2"],
                "capacity": {"concurrency": 2, "session_limit": 4, "per_domain_concurrency": 1},
                "exits": [{"exit": "tmn-user1", "kind": "pc", "up": True, "reason": "", "checked_seconds_ago": 12.5}],
            }
        )

        assert health.kind is RendererKind.HEADLESS
        assert health.state is RendererState.READY
        assert health.capacity.concurrency == 2
        assert health.exits[0].up is True
        assert health.slot == ""

    def test_headed_slot_reports_who_it_is_and_what_it_is_doing(self) -> None:
        health = RendererHealth.model_validate(
            {
                "status": "ok",
                "browser": True,
                "proxies": ["tmn-user1"],
                "exits": [{"exit": "tmn-user1", "up": False}],
                "kind": "headed",
                "slot": "gpu-1.tmn-user1",
                "state": "site_blocked",
                "prepared_hosts": ["vseinstrumenti.ru"],
            }
        )

        assert health.kind is RendererKind.HEADED
        assert health.state is RendererState.SITE_BLOCKED
        assert health.prepared_hosts == ["vseinstrumenti.ru"]

    def test_unknown_state_is_rejected(self) -> None:
        with pytest.raises(ValidationError):
            RendererHealth.model_validate({"status": "ok", "browser": True, "state": "sleeping"})


def test_price_hints_js_is_a_page_function_returning_hints_and_title_bottom() -> None:
    """Строка уходит в `page.evaluate` как есть: это должно быть выражение-функция."""
    assert PRICE_HINTS_JS.strip().startswith("() => {")
    assert "hints: out.slice(0, 40)" in PRICE_HINTS_JS
    assert "title_bottom" in PRICE_HINTS_JS
