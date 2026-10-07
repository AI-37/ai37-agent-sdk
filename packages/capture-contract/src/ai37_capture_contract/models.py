"""Контракт захвата карточки: запрос, снимки, ответ.

Источник правды — этот пакет. browser-worker минстроя (`app/browser_worker/schemas.py`) и рендереры
вне кластера (website-scraper) берут модели отсюда: две копии контракта разъезжались бы, и раннер
агента читал бы ответ рендерера не так, как тот его писал.

Один синхронный вызов возвращает **все снимки одной сессии** — так требование «второй снимок той
же сессии с тем же `captured_at`» выполняется по построению. `storage_state` в контракте нет ни на
входе, ни на выходе: это чужие куки продавца, а накопленное состояние сделало бы снимок зависящим от
истории прогонов.

Роль, геометрия и масштаб каждого снимка нужны агенту: без них bbox от Vision не перевести в crop.
"""

from __future__ import annotations

from datetime import datetime  # noqa: TC003 — pydantic резолвит аннотации в рантайме
from enum import StrEnum

from pydantic import BaseModel, Field


class ScreenshotRole(StrEnum):
    """Зачем снят кадр. Срез 3 выбирает по роли, какой снимок отдать Vision."""

    VIEWPORT = "viewport"
    FULL_PAGE = "full_page"
    TILE = "tile"
    CHARACTERISTICS = "characteristics"
    #: Единственная роль, которую снимает не воркер, а агент: экран 1440×1000 с рамкой вокруг
    #: доказательства. Рамку рисуют после Vision, когда известно, где на странице цена, — воркеру
    #: это знание взяться неоткуда. Роль живёт здесь же, чтобы у всех кадров строки был один
    #: словарь: документ и архив разбирают их одним кодом.
    EVIDENCE = "evidence"


class CaptureStatus(StrEnum):
    """Исход захвата. `OK` — снимки есть; всё остальное объясняет, почему их нет или мало."""

    OK = "OK"
    PAGE_UNAVAILABLE = "PAGE_UNAVAILABLE"
    CAPTCHA_DETECTED = "CAPTCHA_DETECTED"
    NAVIGATION_REJECTED = "NAVIGATION_REJECTED"
    TIMEOUT = "TIMEOUT"
    ERROR = "ERROR"


#: Карточку не открывали: предыдущая карточка пачки упёрлась в антибот через тот же выход. Qrator
#: ставит капчу на каждую следующую карточку, и ходить дальше тем же адресом — только углублять
#: бан и жечь бюджет пачки. Статус — `CAPTCHA_DETECTED` с меткой выхода: по нему агент меняет выход.
REASON_EXIT_BLOCKED = "EXIT_BLOCKED"
#: Карточку не открывали: домен на паузе после капчи дольше, чем осталось у вызова. Метки выхода у
#: такого ответа нет намеренно — через выход не ходили, банить его не за что.
REASON_DOMAIN_COOLDOWN = "DOMAIN_COOLDOWN"
#: Карточку не открывали: предыдущая в пачке показала витрину другого города. Раньше пачка
#: снималась целиком и выбрасывалась — до двадцати шести загрузок впустую, и все в бюджет выхода.
#: Метки выхода тут нет намеренно: город — дело подготовки магазина, а не адреса.
REASON_REGION_MISMATCH = "REGION_MISMATCH"
#: Сайт ответил, что карточки нет (404 и его витринные заглушки). Статус — `PAGE_UNAVAILABLE`: адрес
#: выхода тут ни при чём, и банить его не за что.
REASON_NOT_FOUND = "NOT_FOUND"
#: Сайт закрыл АДРЕС, а не отпечаток браузера: заглушка «отключите VPN». Статус — `CAPTCHA_DETECTED`
#: с меткой выхода: менять надо выход, повторная попытка с того же адреса ничего не даст.
REASON_SITE_BLOCKED = "SITE_BLOCKED"
#: Карточку никто не открывал: рендерера нужного вида нет в строю. Отдельно от исчерпанных выходов —
#: «машина с рендерером выключена» и «антибот закрыл адреса» чинятся разными людьми.
REASON_RENDERER_UNAVAILABLE = "RENDERER_UNAVAILABLE"
#: Главная магазина не открылась при подготовке сессии: сеть, таймаут, отказ выхода. Карточки пачки
#: не снимались — подготовке нечем было закончиться.
REASON_HOME_UNREACHABLE = "HOME_UNREACHABLE"
#: Гейт навигации не пустил: хоста нет в закрытом мире задания (`allowed_hosts`). Статус —
#: `NAVIGATION_REJECTED`; это ошибка входного файла или редирект на чужой домен, а не сбой сети.
REASON_HOST_NOT_ALLOWED = "HOST_NOT_ALLOWED"


class Clip(BaseModel):
    """Прямоугольник кадра в координатах документа (CSS-пиксели)."""

    x: int
    y: int
    w: int
    h: int


class Screenshot(BaseModel):
    """Один кадр с доказательной геометрией.

    `sha256` считается по байтам PNG, уже уехавшим в хранилище: хэш и объект — одно и то же.
    """

    role: ScreenshotRole
    storage_key: str
    sha256: str = Field(min_length=64, max_length=64)
    width: int = Field(ge=1)
    height: int = Field(ge=1)
    device_scale_factor: float = Field(ge=0.1)
    clip: Clip | None = None
    scroll_offset: int = Field(default=0, ge=0)
    byte_size: int = Field(ge=1)


class CaptureEnvironment(BaseModel):
    """Окружение снимка. Едет в метаданные ради диагностики: по нему разбирают, почему цена не
    прочиталась именно на этой карточке."""

    browser_build: str
    #: Версия драйвера браузера — Patchright (патченый форк Playwright). Имя поля нейтральное:
    #: драйвер уже менялся один раз, и значение врало бы именем.
    driver_version: str
    viewport_width: int
    viewport_height: int
    device_scale_factor: float
    locale: str
    timezone_id: str
    color_scheme: str
    reduced_motion: str
    fonts: list[str] = Field(default_factory=list)


class ActionRecord(BaseModel):
    """Журнал разрешённых действий: что сделали на карточке и чем это кончилось."""

    kind: str
    target: str | None = None
    ok: bool
    detail: str | None = None


class CaptureRequest(BaseModel):
    """Задание на захват одной карточки товара."""

    url: str
    ksr_code: str
    #: Ожидаемые признаки товара — наименование и артикул продавца; нужны для выбора варианта
    #: товара на странице и уезжают в журнал действий. Сверку делает срез 3, не браузер.
    expected_name: str | None = None
    expected_article: str | None = None
    #: Город, который выбираем действием в начале сессии. Без него часть магазинов отдаёт цену
    #: московского склада при формально успешном захвате (§3.2).
    region: str = "Тюмень"
    #: Закрытый мир навигации задания: хосты, выведенные из URL входного файла. Складывается по И
    #: с проверкой приватных адресов и с глобальным потолком `BROWSER_ALLOWED_HOSTS`.
    allowed_hosts: list[str] = Field(default_factory=list)
    #: Нужны ли снимки блока характеристик — второй проход по той же сессии.
    want_characteristics: bool = True
    #: Зайти ли сначала на главную магазина и уже оттуда — на карточку. Регион выбирается ИМЕННО
    #: там: на карточке модалки выбора города обычно нет, и без прогрева снимается витрина чужого
    #: склада (ЭТМ показывал московскую цену при заказанной Тюмени). Попутно на главной проходится
    #: JS-проверка антибота, и карточка грузится уже с готовой кукой.
    warm_up_home: bool = True
    #: Бюджет времени на задание. Пусто — берётся `BROWSER_TIMEOUT_SECONDS`.
    time_budget_seconds: float | None = Field(default=None, ge=5.0, le=600.0)
    #: Выход через прокси: какой предпочесть (метка) и какие не трогать — магазин их уже забанил.
    #: Метки, а не адреса: адреса с логинами живут в секрете воркера, агент их не знает.
    proxy: str = ""
    avoid_proxies: list[str] = Field(default_factory=list)


class PriceHint(BaseModel):
    """Ценоподобный текст, найденный в DOM карточки, и где он на странице.

    Это не цена — это место, куда смотреть. Читает и подтверждает по-прежнему Vision, но уже на
    кропе с точными координатами, без вызова локатора по двенадцати полосам.
    """

    text: str
    x: int = Field(ge=0)
    y: int = Field(ge=0)
    w: int = Field(gt=0)
    h: int = Field(gt=0)
    #: Текст вокруг числа (подпись «Для юрлиц», «в месяц», единица). До 80 символов.
    label: str = ""
    #: Единица после валюты, если написана: «₽/м²» → «м²».
    unit: str = ""
    #: Число перечёркнуто — старая цена.
    struck: bool = False
    #: Размер шрифта, px: главная цена карточки почти всегда крупнее соседних.
    font_size: float = 0.0


class CaptureResponse(BaseModel):
    """Результат одной сессии: один `captured_at` на все снимки."""

    captured_at: datetime
    final_url: str | None
    title: str | None
    status: CaptureStatus
    screenshots: list[Screenshot] = Field(default_factory=list)
    environment: CaptureEnvironment | None = None
    actions: list[ActionRecord] = Field(default_factory=list)
    reason_code: str | None = None
    detail: str | None = None
    #: Ценоподобные узлы DOM с координатами страницы. Пусто — цена не в тексте (картинкой,
    #: canvas), и агент идёт прежним путём через локатор по полосам.
    price_hints: list[PriceHint] = Field(default_factory=list)
    #: Низ заголовка товара (h1) в координатах страницы — якорь: цены карточки лежат под ним,
    #: цены «похожих товаров» — заметно ниже. 0 — заголовка нет.
    title_bottom: int = Field(default=0, ge=0)
    #: Сколько заняла эта карточка, включая ожидание своей очереди к домену. В пачке вызов один на
    #: все карточки, и без этого поля метрика длительности захвата мерила бы пачку, а не карточку.
    elapsed_seconds: float = Field(default=0.0, ge=0.0)
    #: Город, как он написан на странице. Это ДАННЫЕ, а не вердикт: ЭТМ показывает «купить в
    #: Москве» при заказанной Тюмени, и сегодня цена чужого склада подтверждается молча.
    page_region: str = ""
    #: Метка выхода, через который ходили. Пусто — напрямую. По ней агент понимает, какой адрес
    #: магазин забанил, и запоминает это на следующий прогон.
    proxy: str = ""
    #: Ключ разбора отказа в хранилище (`diagnostics/…json`). Заполняется только у неудачи: у
    #: снятой карточки разбирать нечего. Рядом с ним лежат снимок и DOM того же момента.
    diagnostics_key: str | None = None
    #: Сколько ещё ждать паузы домена. Заполняется только у `DOMAIN_COOLDOWN`: по нему очередь
    #: откладывает кусок для этого выхода ровно на столько, а не на свою догадку. Текст `detail`
    #: то же число называет словами, но разбирать текст — значит сделать формулировку контрактом.
    retry_after_seconds: float | None = None


class CaptureBatchItem(BaseModel):
    """Одна карточка внутри пачки: всё, чем она отличается от соседней."""

    url: str
    ksr_code: str
    expected_name: str | None = None
    expected_article: str | None = None


class CaptureBatchRequest(BaseModel):
    """Пачка карточек ОДНОГО магазина, снимаемых в общей подготовленной сессии.

    Подготовка (главная, cookie-баннер, город, JS-проверка антибота) проходится один раз на пачку,
    а не на карточку: для файла из 26 позиций одного продавца это 26 подготовок против одной.
    Хост проверяется воркером по каждому URL отдельно — клиенту здесь не верят, и карточка чужого
    домена получит отказ гейта, а не поездку в чужой сессии.
    """

    items: list[CaptureBatchItem] = Field(min_length=1)
    #: Сессия, подготовленная разведкой. Пусто — воркер готовит магазин сам, как и раньше.
    #: Сессию закрывает агент (`POST /session/close`): карточек у магазина может быть больше, чем
    #: помещается в одну пачку, и терять подготовку между пачками незачем.
    session_id: str = ""
    region: str = "Тюмень"
    allowed_hosts: list[str] = Field(default_factory=list)
    #: Магазин помечен медленным в памяти прошлых прогонов: он уже показывал антибот-проверку.
    #: Воркер и сам помечает такие после первого challenge, но своя память у него живёт до рестарта
    #: пода — а бан живёт дольше, и знает о нём агент.
    slow: bool = False
    want_characteristics: bool = True
    #: Готовить ли сессию перед первой карточкой. Выключается только в тестах и на главной странице.
    warm_up_home: bool = True
    #: Бюджет времени на пачку целиком. Исчерпан — оставшиеся карточки возвращаются с `TIMEOUT`,
    #: и агент присылает их следующей пачкой: один медленный магазин не занимает воркер насовсем.
    time_budget_seconds: float | None = Field(default=None, ge=5.0, le=3600.0)
    #: Бюджет на одну карточку. Пусто — берётся `BROWSER_TIMEOUT_SECONDS`.
    card_budget_seconds: float | None = Field(default=None, ge=5.0, le=600.0)
    #: Выход через прокси для сессии пачки, если её открывает сама пачка (без разведки).
    proxy: str = ""
    avoid_proxies: list[str] = Field(default_factory=list)

    def card_request(self, item: CaptureBatchItem) -> CaptureRequest:
        """Задание на одну карточку пачки — тот же контракт, что у одиночного `/capture`.

        `warm_up_home` снят: сессия уже подготовлена, и второй заход на главную был бы лишним
        стуком в тот же домен.
        """
        return CaptureRequest(
            url=item.url,
            ksr_code=item.ksr_code,
            expected_name=item.expected_name,
            expected_article=item.expected_article,
            region=self.region,
            allowed_hosts=self.allowed_hosts,
            want_characteristics=self.want_characteristics,
            warm_up_home=False,
            time_budget_seconds=self.card_budget_seconds,
        )


class CaptureBatchResponse(BaseModel):
    """Результаты пачки: ровно по одному на каждый элемент запроса и в том же порядке.

    Порядок — часть контракта: агент сопоставляет ответы со строками входного файла по позиции,
    и перестановка молча приписала бы цену чужой строке.
    """

    results: list[CaptureResponse] = Field(default_factory=list)
    #: Удалась ли подготовка сессии. `False` — карточки не снимались вовсе, причина в `detail`.
    prepared: bool = True
    #: Журнал подготовки: он общий для всей пачки и потому лежит отдельно от журналов карточек.
    preparation: list[ActionRecord] = Field(default_factory=list)
    detail: str | None = None
    #: Метка выхода, через который шла пачка. Пусто — напрямую.
    proxy: str = ""
