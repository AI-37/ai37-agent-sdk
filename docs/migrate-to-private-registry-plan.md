# Приватизация SDK-экосистемы AI37 (npm + PyPI + git-репозитории)

> Ecosystem-wide план (охватывает несколько репозиториев org `AI-37`; живёт в `ai37-agent-sdk`
> как каноническом SDK-репо). Пути к файлам даны относительно корня рабочего пространства AI37.
> Статус: **утверждён**. Реализация не начата.

## Context

Экосистема AI37 состоит из публичных SDK-пакетов (`@ai37/*` в npm и `ai37-*` в PyPI) и их
публичных git-репозиториев в GitHub-org **`AI-37`**. Все они публиковались как «внутренние»,
но формально доступны кому угодно. Нужно закрыть их: сделать пакеты и репозитории приватными
так, чтобы **все потребители** (`sp-ai/indexer`, `chat-backend`, `rag-factory`, `ui`,
`spai-elevator/thermal/consultant-agent`, `widgets/widget-ui`, `sideprojects/Minstroy`)
продолжали собираться и деплоиться.

**Утверждённая стратегия:**
- **Хостинг — full serverless в Yandex Cloud, ВНЕ prod-кластера.**
  - **npm →** Verdaccio как **Serverless Container** со stateless S3-backend (плагин
    `verdaccio-aws-s3-storage`, S3-only режим) поверх Object Storage. Проксирует публичный npmjs
    для остальных зависимостей. Scope `@ai37` не меняем.
  - **Python →** статический **PEP 503 индекс в Object Storage** за тонким **auth-proxy**
    (второй Serverless Container). devpi/pypiserver НЕ используется.
- **Реестры на публичном HTTPS-endpoint** — нужно, чтобы удалённые/аутсорс-разработчики
  устанавливали пакеты локально. Приватность держится **только на аутентификации**, не на сети.
- **Управление доступом — декларативно в Terraform** (раздел `private_registry` в tfvars
  `02-platform`): per-identity htpasswd-токены; грант/ревок = правка tfvars + `terraform apply`.
  **Authentik НЕ используется** (он — SSO пользовательских сервисов, не npm/pip-клиентов).
- **Прошлые публичные версии →** попытка `unpublish` где допустимо + `deprecate` остального +
  аудит на утёкшие секреты и ротация.
- **git-репозитории `AI-37/*` → private.**

### Ключевые факты, определяющие план
1. **Все npm-пакеты уже scoped `@ai37/*`** → переименований и churn'а имён не требуется.
2. **Приватность НЕ ретроактивна** — уже скачанное/закешированное зеркалами (unpkg, jsdelivr,
   yarn-кеш, реплики) не отзывается. Цель достижима как «приватно с этого момента». **Поэтому
   обязателен аудит опубликованных тарболов на секреты и ротация найденного — независимо от всего.**
3. **GitHub Packages исключён**: для npm требует scope == имя org, но org=`AI-37`≠scope`@ai37`
   (переименование = churn во всех пакетах и потребителях), и не поддерживает Python вовсе.
4. `ui` и `widget-ui` уже имеют целевой паттерн Docker build-secret (`--mount=type=secret,id=npmrc`)
   с graceful-fallback — эталон для тиражирования.
5. **Публичный serverless-endpoint ⇒ единственный барьер = auth.** Отсюда: `access: $authenticated`
   на ВСЕ пакеты (и `@ai37/*`, и проксируемые `**`), TLS, запрет саморегистрации. Phase 7
   (управление доступом) — несущая стена, не довесок.

## Полная инвентаризация пакетов

**npm `@ai37/*` (публичные → приватизировать):** `agent-sdk`, `agent-host`
(репо `AI-37/ai37-agent-sdk`); `a2a-redis-task-store` (репо `AI-37/ai37-a2a-redis-task-store`);
`a2ui-catalog-schemas`, `a2ui-catalog-react` (репо `AI-37/ai37-a2ui-catalog`);
`lift-calc-schemas` (репо `AI-37/ai37-catalog` — **нет в локальном checkout**);
`copilotkit-md-renderer`, `copilotkit-chat-helpers` (**источник не найден локально — внешний репо
`AI-37/*`, найти на GitHub**). `@ai37/billing-apps-client` — ещё НЕ опубликован → публиковать сразу
в приватный реестр.

**PyPI (публичные → перенести):** `ai37-agent-sdk` (0.1.0a3), `ai37-agent-host` (0.1.0a9)
— репо `AI-37/ai37-agent-sdk`; `ai37-a2ui-catalog` (0.3.1) — репо `AI-37/ai37-a2ui-catalog`.

**Публикующие workflow сейчас:**
- `ai37-agent-sdk` — **4 воркфлоу** (`publish-ts.yml`, `publish-ts-host.yml`, `publish-python.yml`,
  `publish-python-host.yml`; `workflow_dispatch` по пакету, версия из манифеста, `dry_run`-gate,
  выбор ubuntu/self-hosted-раннера). Сейчас публикуют в **публичные** npmjs+PyPI. Секреты:
  `NPM_TOKEN`, `PYPI_TOKEN`.
- `ai37-a2ui-catalog/.github/workflows/cd.yml` (npm `NODE_AUTH_TOKEN`←`NPM_TOKEN` + PyPI
  `PYPI_API_TOKEN`).
- `ai37-billing-apps-client/.github/workflows/cd.yml` (`npm publish --access public --provenance`).
- `ai37-a2a-redis-task-store` — публикуется вручную, CD нет.

---

## Phase 0 — Аудит и подготовка (до любых изменений)

1. **Секрет-скан** всех репозиториев и всех опубликованных тарболов: `gitleaks`/`trufflehog` по
   git-истории + `npm pack @ai37/<pkg>@<ver>` для каждой версии и grep на ключи
   (LiteLLM/Lago/Authentik/S3/JWT). **Любой найденный секрет ротировать.** То же для sdist/wheel PyPI.
2. **Граф внутренних зависимостей** публичных пакетов: `npm view @ai37/<pkg> dependencies` —
   для порядка `unpublish` (Phase 5) и порядка републикации (Phase 2).
3. **Найти недостающие репозитории** под org `AI-37`: `ai37-catalog` (даёт `@ai37/lift-calc-schemas`)
   и репо(зитории) `@ai37/copilotkit-*` (`gh repo list AI-37`). Без них приватизация неполна.
4. **Статистика скачиваний** каждого пакета
   (`https://api.npmjs.org/downloads/point/last-week/@ai37/<pkg>`) — какие пройдут CLI-`unpublish`
   (<300/нед), а какие только `deprecate`.

## Phase 1 — Поднять приватные реестры (full serverless, Yandex), терраформ в 02-platform

> ✅ **Спайк-гейт ПРОЙДЕН (29-07, локально на MinIO).** Verdaccio 6.9.0 + `verdaccio-aws-s3-storage`
> стартует с `dynamoTableName: none` (S3-only), опубликованный `@ai37/*` пакет переживает
> `--force-recreate` контейнера и ставится из чистого кэша ⇒ реестр персистит в S3, диск не нужен ⇒
> serverless валиден. Харнесс: `infra/02-platform/private-registry-spike/` (`bash run-spike.sh`).
> Остаётся повторить прогон против **живого Yandex Object Storage** (нюансы ACL/подписи).
> **Пререквизит:** в `02-platform` сейчас НЕТ yandex-провайдера (только google/twc/k8s/helm/grafana) —
> добавить `yandex` в `versions.tf`+`provider.tf` + креды SA (по образцу `01-foundation`).

Инфра — новый модуль **`infra/02-platform/terraform/private-registry/`** (провайдер Yandex).
Реестры физически в Yandex serverless, но управляются скоупом `02-platform` (там же authentik/lago/
litellm; tfvars в `infra/environments/<env>/02-platform.tfvars`).

**Verdaccio (npm) — Serverless Container + Object Storage (stateless):**
- Хранилище: `verdaccio-aws-s3-storage` в **S3-only режиме** (без DynamoDB) → тарболы, метаданные,
  package-list, registry-secret в бакете `ai37-verdaccio` (versioning вкл. = бэкап; single-node-риска
  VM нет).
- Деплой: Serverless Container (ревизия на образ Verdaccio). Все env — из Terraform:
  - `VERDACCIO_HTPASSWD` — содержимое htpasswd (Terraform собирает из bcrypt-хэшей `accounts`,
    см. Phase 7); entrypoint пишет файл на старте (эфемерный FS ок — состояние в S3).
  - `VERDACCIO_SECRET` — стабильный JWT-secret (иначе токены слетают на каждой ревизии).
  - S3 endpoint/креды на бакет.
- Публичный HTTPS-endpoint контейнера; свой домен `npm.app.sp-ai.ru` — через API Gateway/CNAME.
- `config.yaml`: `packages['@ai37/*']` и `['**']` = `access: $authenticated`; `uplinks.npmjs`;
  приватные — **без `proxy`**; умеренный JWT TTL (`security.api.jwt.sign.expiresIn`) — чтобы ревок
  распространялся.
- Cold-start первого install после простоя — секунды (для dev/CI ок). Free-tier (1M вызовов /
  10 GB×ч RAM / 5 vCPU×ч мес) ≈ 0₽ + копейки за Object Storage.

**Python (PyPI) — статический PEP 503 индекс в Object Storage за auth-proxy:**
- `simple/<pkg>/<wheel|sdist>` + сгенерированные index-страницы (PEP 503) в бакете `ai37-pypi`.
  Сервера нет.
- Приватность (бакет не публичный): **тонкий auth-proxy вторым Serverless Container** с basic-auth
  (htpasswd из того же Terraform) перед бакетом. **РЕШЕНО:** proxy обслуживает И чтение (`GET /simple/…`),
  И публикацию (`PUT` wheel + регенерация индекса) — обе операции по basic-auth тем же `AI37_PYPI_TOKEN`
  (роль решает read vs publish). Итог: **Object Storage S3-ключи живут ТОЛЬКО внутри proxy (из
  Terraform/infra) и в GitHub-секреты не выдаются.** Клиенты знают лишь `https://pypi.app.sp-ai.ru/simple/`
  + токен.

**tfvars-раздел `private_registry`** (`infra/environments/<env>/02-platform.tfvars` + `.example`):
```hcl
private_registry = {
  enabled   = true                     # kill-switch: false → реестры не создаются (rollback)
  npm_host  = "npm.app.sp-ai.ru"
  pypi_host = "pypi.app.sp-ai.ru"
  # По записи на идентичность (люди-разработчики и сервисы). bcrypt = ТОЛЬКО хэш из `htpasswd -nbB`.
  accounts = {
    ci-read    = { npm = true,  pypi = true,  role = "read",    bcrypt = "$2y$10$…hashA", note = "read: все репо-потребители" }
    ci-publish = { npm = true,  pypi = true,  role = "publish", bcrypt = "$2y$10$…hashB", note = "publish: все SDK-издатели" }
    alice-fe   = { npm = true,  pypi = false, role = "read",    bcrypt = "$2y$10$…hashC", note = "внешний фронт-дев, до 2026-10-01" }
    bob-py     = { npm = false, pypi = true,  role = "read",    bcrypt = "$2y$10$…hashD", note = "внешний python-дев" }
  }
}
```
Terraform читает `accounts` → собирает htpasswd → env `VERDACCIO_HTPASSWD` и env auth-proxy.
`enabled=false` = снести/не создавать. Пример заполнения и проводку токенов см. в разделе
**«Reference: заполнение и проводка секретов»**.

**Домены, TLS, DNS (поздний шаг, НЕ первый):**
- У Serverless Container нет прямого кастомного домена → фронтим **API Gateway**, интегрированным с
  контейнером(ами); TLS — **Certificate Manager** (Let's Encrypt) с DNS-валидацией.
- `01-foundation` держит только *зону* `app.sp-ai.ru` (`yandex_dns_zone.external_dns`); записи для
  кластерных сервисов автоматически ведёт **external-dns из Ingress**. У serverless Ingress'а нет →
  нужны **явные `yandex_dns_recordset`**: (1) CNAME валидации сертификата (от Cert Manager) и
  (2) CNAME `npm`/`pypi` → домен API Gateway (`<id>.apigw.yandexcloud.net`). `npm.app.sp-ai.ru` /
  `pypi.app.sp-ai.ru` — ≥3-го уровня, CNAME допустим.
- **Размещение записей — в `02-platform`** (рядом с gateway/сертификатом), ссылаясь на `id` зоны из
  **foundation-outputs** (platform уже читает foundation remote state). НЕ в `01-foundation` — иначе
  обратная зависимость foundation→platform. Так весь стек тестируется через `make ENV=prod platform-plan`.

## Phase 2 — Опубликовать все пакеты в приватные реестры

1. В каждом публикуемом `package.json` заменить `publishConfig`:
   `access: public` → `registry: https://npm.app.sp-ai.ru/`. Файлы:
   `ai37-agent-sdk/packages/ts/package.json`, `.../ts-host/package.json`,
   `ai37-a2a-redis-task-store/package.json`,
   `ai37-a2ui-catalog/packages/catalog-schemas/package.json`, `.../catalog-react/package.json`,
   `ai37-billing-apps-client/package.json`, + `ai37-catalog` и `copilotkit-*` (после Phase 0.3).
2. Опубликовать текущие версии в Verdaccio (порядок зависимостей: базы → зависимые). Python — собрать
   `poetry build` и залить wheel/sdist в `ai37-pypi` + регенерировать PEP503-индекс.
3. Проверить чистую установку `@ai37/*` и `ai37-*` из приватных реестров по токену (и отказ без токена).

## Phase 3 — Подключить потребителей (одинаковый паттерн)

**npm-потребители — Docker build-secret** (эталон: `sp-ai/ui/Dockerfile:10-11`):
- Добавить `.npmrc` в корень каждого репо:
  ```
  @ai37:registry=https://npm.app.sp-ai.ru/
  //npm.app.sp-ai.ru/:_authToken=${AI37_NPM_TOKEN}
  ```
  (реальный токен только через build-secret / CI-env, НЕ в слои образа).
- Растиражировать паттерн build-secret на Dockerfile'ы без него: `sp-ai/chat-backend/Dockerfile`,
  `sp-ai/rag-factory/Dockerfile`, `spai-elevator-calc-agent/Dockerfile`,
  `spai-thermal-calc-agent/Dockerfile`, `spai-consultant-agent/Dockerfile`.
- `sp-ai/indexer/Dockerfile` — мигрировать с `COPY .npmrc` на build-secret.
- В каждом `cd.yml` пробросить секрет в `docker/build-push-action` через `secrets:` (референс:
  `sp-ai/ui/.github/workflows/cd.yml`, `widgets/widget-ui/.github/workflows/cd.yml`).
- В каждом `ci.yml` (`npm ci` через `actions/setup-node`) — шаг записи `.npmrc` с `@ai37:registry`
  + `NODE_AUTH_TOKEN=${{ secrets.AI37_NPM_TOKEN }}` перед `npm ci`.

**Python-потребитель `sideprojects/Minstroy`:**
- В `pyproject.toml`/uv-конфиге прописать приватный индекс: `--index-url`/`extra-index-url`
  `https://pypi.app.sp-ai.ru/simple/` (публичный PyPI как второй индекс, если нужно).
- В `Dockerfile` проброс `AI37_PYPI_TOKEN` через build-secret (`UV_INDEX_*`/`PIP_INDEX_URL`
  с basic-auth), в `cd.yml` — секрет. `widget-backend` — без изменений (не тянет ai37-пакеты).

## Phase 4 — Перенацелить и стандартизировать публикующие workflow

> ⚠️ **Очерёдность:** перенацелить НАДО до первого пост-миграционного публиша, иначе воркфлоу
> продолжат заливать новые ПУБЛИЧНЫЕ версии — против Phase 5.

**Стандартизация имён GitHub-секретов** (единообразно во всех репо; значение одинаково по ИМЕНИ,
разное по РОЛИ — publish у издателей, read у потребителей):
- npm: `NPM_TOKEN` → **`AI37_NPM_TOKEN`**.
- Python: `PYPI_TOKEN` (agent-sdk) И `PYPI_API_TOKEN` (a2ui-catalog `cd.yml:128`) → **`AI37_PYPI_TOKEN`**.

**`ai37-agent-sdk` — 4 воркфлоу УЖЕ существуют**, сейчас публикуют в публичные реестры → перенацелить:
- `publish-ts.yml`, `publish-ts-host.yml` (это и есть «agent-host cd» — отдельного репо нет):
  `registry-url: https://registry.npmjs.org` → `https://npm.app.sp-ai.ru/` **И** проставить
  `publishConfig.registry` в `packages/ts(-host)/package.json`. Оба места должны совпасть (иначе npm
  берёт `publishConfig.registry`). Секрет → `AI37_NPM_TOKEN` (publish-токен Verdaccio).
- `publish-python.yml`, `publish-python-host.yml`: вместо `poetry publish` (в публичный PyPI) —
  `poetry build` + **`PUT` артефактов через auth-proxy** (`https://pypi.app.sp-ai.ru/…`, basic-auth
  `AI37_PYPI_TOKEN` роли publish); proxy сам кладёт в бакет и регенерирует PEP503-индекс. S3-ключей в
  CI издателя НЕ нужно (живут в infra).
- **Узел `publish-python-host.yml`:** его `install`/`verify` тянут `ai37-agent-sdk` из публичного
  PyPI. После Phase 5 `poetry install` упадёт → добавить приватный индекс как `extra-index-url`
  для install/verify, не только для publish. Проверить `dry_run`.
- **Оставить как есть:** self-hosted-раннер (`ai37-self-hosted`/`ai37-local-1`) и `dry_run`-gate
  (self-hosted = митигация Actions-минут, см. Phase 6). OIDC trusted-publishing не используем —
  он не работает с self-hosted-раннерами; отсюда Automation/API-токены.

**Остальные SDK-репо:**
- `ai37-a2ui-catalog/.github/workflows/cd.yml`: npm → Verdaccio (`AI37_NPM_TOKEN`); Python → загрузка
  в `ai37-pypi` (`AI37_PYPI_TOKEN`).
- `ai37-billing-apps-client/.github/workflows/cd.yml`: registry → Verdaccio (`AI37_NPM_TOKEN`);
  **убрать `--provenance` и `--access public`** (provenance — npmjs+sigstore, для публичных репо).
- `ai37-a2a-redis-task-store`: добавить publish-workflow (по образцу `ai37-agent-sdk`) → Verdaccio.
- `ai37-catalog` / `copilotkit-*` (после Phase 0.3): аналогично → Verdaccio.

## Phase 5 — Закрыть публичный доступ к прошлым версиям

1. **npm `unpublish` в обратном порядке зависимостей** (листья → базы), где пакет проходит
   CLI-условия (<300 dl/нед, один владелец, нет публичных зависимых): `npm unpublish @ai37/<pkg> -f`.
   Что не проходит → `npm deprecate @ai37/<pkg> "moved to a private registry"`.
   (Полное удаление блокирует републикацию имени на npmjs 24ч — нам безразлично.)
2. **PyPI**: удалить релизы через веб-UI проекта. Имя версии/файла переиспользовать больше нельзя —
   не помеха (мы в приватном индексе).
3. Довести **ротацию секретов**, найденных в Phase 0.1.

## Phase 6 — Сделать git-репозитории приватными

Перевести в private все SDK-репо org `AI-37`: `ai37-agent-sdk`, `ai37-a2ui-catalog`,
`ai37-a2a-redis-task-store`, `ai37-billing-apps-client`, `agent-template-js`, `ai37-catalog`,
`copilotkit-*`.

**Грабли:**
- **GitHub Actions минуты**: public-репо безлимитны, private тратят org-минуты (Free ~2000/мес).
  **Митигация уже проложена:** publish-воркфлоу `ai37-agent-sdk` умеют self-hosted-раннер
  (`ai37-self-hosted`/`ai37-local-1`). Тиражировать опцию на CI/CD остальных приватизируемых репо.
  (Реестр всё равно на публичном endpoint — раннер тут только про минуты, не про доступ к реестру.)
- **GitHub Pages**: `ai37-a2ui-catalog/.github/workflows/pages.yml` публикует каталог. Pages из
  private-репо требует Pro/Team/Enterprise. Решить: оставить схемы публичными / за авторизацию /
  отключить `pages.yml`.
- **Cross-repo checkout / submodules**: планируемый shared-schema submodule (indexer/rag-factory).
  Private базовый репо → клоны в CI требуют deploy-key/PAT. Проверить `.gitmodules` и чужие
  `actions/checkout`; выдать узкие deploy-keys.
- Уже сделанные форки/клоны/звёзды у сторонних остаются у них.

## Phase 7 — Управление доступом = Terraform-declared per-identity токены (без Authentik)

**Authentik исключён** — он для SSO пользовательских сервисов, не для npm/pip-клиентов. Доступ к
реестрам = **предсконфигурированные per-identity токены, объявленные в Terraform** (раздел
`private_registry.accounts`, Phase 1). Грант/ревок = правка tfvars + `terraform apply` → новая
ревизия контейнера.

- **Модель:** одна htpasswd-запись на идентичность (человек `alice-fe`; машины `ci-read`,
  `ci-publish`). Terraform собирает их в `VERDACCIO_HTPASSWD` и в htpasswd Python-auth-proxy.
  **Аутентификация клиентов — basic-auth `_auth`** (`//host/:_auth=<base64(user:pass)>` в `.npmrc`),
  НЕ `npm login`/`_authToken`: спайк показал, что при `max_users:-1` токен-эндпоинт `/-/user` отдаёт
  `409` даже существующему юзеру. GitHub-секрет `AI37_NPM_TOKEN` несёт этот `_auth`. Per-identity →
  отзыв одного не трогает других; общих секретов нет → при уходе ротировать нечего.
- **Грант:** добавить bcrypt-запись в `accounts` → `apply`. **Ревок:** удалить запись → `apply`
  (новая ревизия; JWT добивается по TTL).
- **Грабля:** в tfvars хранить **готовые bcrypt-хэши** (`htpasswd -nbB`), НЕ plaintext через
  `bcrypt()` в Terraform (новая соль каждый apply → вечный diff/лишняя ревизия). Хэши — в
  `.gitignore`-tfvars/секрете; git-история tfvars = аудит доступа.
- **Человек/машина разделены:** `ci-*` только в GitHub Actions secrets/k8s, людям не выдаются →
  ротация человека не требует ротации CI.
- **GitHub-доступ** к репо — независимо: **Outside Collaborators** (GitHub-native), роль по минимуму
  (Read; Write только если пушит), 2FA на org, branch protection + required review (работа через
  форк/PR). На GitHub Team каждый outside-collaborator на private-репо = платное место.
- **Гардрейлы:** read людям / publish за CI; TLS (Yandex endpoint); нет саморегистрации;
  периодический review списка `accounts`.

---

## Reference: заполнение `private_registry` и проводка секретов

**Как получить `bcrypt` для tfvars:** `htpasswd -nbB alice-fe 'СГЕНЕРИРОВАННЫЙ_ПАРОЛЬ'` → строка
`alice-fe:$2y$10$…`; в tfvars кладём ТОЛЬКО хэш (`$2y$10$…`). Пароль отдать разработчику защищённым
каналом; он делает `npm login --registry https://npm.app.sp-ai.ru/` → JWT в `~/.npmrc`. Для
CI-аккаунтов (`ci-read`/`ci-publish`) — пред-сгенерировать токен Verdaccio один раз и положить как
GitHub-секрет соответствующей роли.

**Репо-ИЗДАТЕЛИ** (секреты = токены роли `ci-publish`):
| Репозиторий | npm → `AI37_NPM_TOKEN` | Python → publish в `ai37-pypi` (`AI37_PYPI_TOKEN`) |
|---|---|---|
| `ai37-agent-sdk` | `@ai37/agent-sdk`, `@ai37/agent-host` | `ai37-agent-sdk`, `ai37-agent-host` |
| `ai37-a2ui-catalog` | `@ai37/a2ui-catalog-schemas`, `…-react` | `ai37-a2ui-catalog` |
| `ai37-a2a-redis-task-store` | `@ai37/a2a-redis-task-store` | — |
| `ai37-billing-apps-client` | `@ai37/billing-apps-client` | — |
| `ai37-catalog`, `copilotkit-*` | `@ai37/lift-calc-schemas`, `@ai37/copilotkit-*` | — |

**Репо-ПОТРЕБИТЕЛИ** (секрет `AI37_NPM_TOKEN` = токен роли `ci-read`; Python — `AI37_PYPI_TOKEN` read):
| Репозиторий | тянет | секрет |
|---|---|---|
| `sp-ai/indexer`, `chat-backend`, `rag-factory`, `ui` | `@ai37/*` (npm) | `AI37_NPM_TOKEN` (read) |
| `spai-elevator/thermal/consultant-calc-agent` | `@ai37/*` (npm) | `AI37_NPM_TOKEN` (read) |
| `widgets/widget-ui` | `@ai37/*` (npm) | `AI37_NPM_TOKEN` (read) |
| `sideprojects/Minstroy` | `ai37-*` (Python) | `AI37_PYPI_TOKEN` (read) |

---

## Verification (end-to-end, сперва в dev)

1. **Реестры живы:** с чистой машины `npm install @ai37/agent-sdk` с токеном → успех; без токена → 403.
   `uv pip install ai37-agent-sdk --index-url https://pypi.app.sp-ai.ru/simple/` с токеном → успех.
2. **Сборка потребителя:** прогнать `cd.yml` одного агента (напр. `spai-elevator-calc-agent`) —
   `npm ci` тянет `@ai37/*` из Verdaccio, остальное — через npmjs-uplink; токен не в слоях
   (`docker history` без токена).
3. **Python-потребитель:** `Minstroy` — `uv sync`/poetry install тянет `ai37-*` из приватного индекса.
4. **Публичный доступ закрыт:** `npm view @ai37/agent-sdk` → 404/deprecate-нотис; unauth-install
   падает. PyPI-страница релиза удалена.
5. **Грант/ревок:** добавить тестового `accounts`-юзера → `terraform apply` → он логинится и ставит;
   удалить → `apply` → доступ пропал.
6. **Полный деплой** одного сервиса через `cd.yml` в dev → сервис поднялся, регрессий нет.
7. **Секрет-скан** повторно чистый; ротированные ключи применены и работают.

## Открытые вопросы / риски
- **[ГЕЙТ ✅ пройден на MinIO 29-07]** `verdaccio-aws-s3-storage` без DynamoDB (round-trip
  publish → recreate → install) — работает. Осталось подтвердить против **живого Yandex Object
  Storage** перед prod (endpoint `storage.yandexcloud.net`, ACL/подпись). Харнесс:
  `infra/02-platform/private-registry-spike/`.
- Пререквизит: добавить yandex-провайдер + SA-креды в `02-platform` (сейчас их там нет).
- Судьба GitHub Pages каталога (`ai37-a2ui-catalog/pages.yml`) после приватизации репо.

_Решено:_ хосты `npm/pypi.app.sp-ai.ru` + привязка домена (API Gateway+Cert Manager, recordset в
02-platform) и Python-auth-proxy с upload (S3-ключи только в infra) — см. Phase 1.
