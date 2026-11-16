> Исследование перенесено из проекта [vscode-1c-repository-tools](https://github.com/iljyxa/vscode-1c-repository-tools)
> (коммит `8391ab0`, `docs/research/07-crs-http.md`) без изменения выводов; текст датирован. Номера
> `iljyxa/vscode-1c-repository-tools#N` относятся к исходному проекту; скрипты `fixtures/tools/*.mjs` остались там же
> (перенос — iljyxa/onecdev#118). Клиент http в onecdev — `src/infra/repository/crs/CrsHttpTransport.ts`;
> решения — [repository-crs.md](../../repository-crs.md).

# Протокол `crs` по http (публикация `.1ccr`)

Дата: 2026-09-29. Платформа 8.5.1.1529, apache 2.4 с `wsap24.so`. Источник — трафик Конфигуратора и пробы
публикации, снятые `node fixtures/tools/capture-locks.mjs --transport=http` исходного проекта; кадры лежат в
`example/crs/8.5.1/http/` (описание — [example/crs/README.md](../../../example/crs/README.md)). Сравнение — с tcp
из [04-crs-protocol.md](04-crs-protocol.md) и `example/crs/8.5.1/tcp/`.

## Как устроен стенд

Собственный apache (`/usr/sbin/apache2`) на `127.0.0.1` со случайным портом: `mpm_prefork`, `authz_core`,
`alias`, `wsap24.so` (модуль `_1cws_module`); каталог публикации `Alias /repo` с `SetHandler 1c-application`;
в нём `repo.1ccr` — `<repository connectString="tcp://127.0.0.1:<порт crserver>/exp"/>`. Apache сам
проксирует вызовы в `crserver`. Конфигуратор подключается к `http://127.0.0.1:<порт>/repo/repo.1ccr/exp`;
между ним и apache стоит записывающий tcp-прокси стенда (пишет сырой HTTP).

Подготовка хранилища и пользователей идёт по tcp, http — только в снимаемых сценариях. Конфигуратор
принимает `/ConfigurationRepositoryF` с http-адресом и для привязанной по tcp базы.

## Что совпадает с tcp

- **Тела запросов и ответов те же.** Во всех 136 кадрах девяти сценариев захвата и отпуска тело по http
  совпадает с телом по tcp после замены uuid, хешей версий (40 hex), дат и имён рабочих баз: тот же конверт
  `crs:call`, `crs:auth`/`crs:bind`, те же методы, тот же порядок вызовов и то же число соединений
  (по сценариям — как в таблице [example/crs/README.md](../../../example/crs/README.md)).
- **`alias` — атрибут конверта** (`alias="exp"`) и параметр `openDevDepot`; в URL POST он не входит:
  запрос идёт на `/repo/repo.1ccr` без сегмента `/exp`.
- **Ошибки бизнес-уровня** — тоже `crs:call_return` / `crs:call_exception` в теле, со статусом HTTP 200:
  неверный пароль и неизвестный пользователь дают `200 OK` с `call_exception` (`clsid` `3ccb2518-…`), отказ
  захвата чужого объекта — `200 OK` с `call_return` и `crs:unprocessed`.

## Чем отличается от tcp

| | tcp | http |
|---|---|---|
| Приветствие | сервер шлёт 5 байт `53f5c61a7b`, клиент — `224855b5` + 16 байт UUID | нет |
| Кадр запроса | `POST  HTTP/1.1` (пути нет, двойной пробел), `Content-Length`, терминатор `6653b2a6` | `POST /repo/repo.1ccr HTTP/1.1`, обычный HTTP/1.1, без терминаторов |
| Заголовки запроса | `Content-Length`, `Accept: application/xml`, `Content-Type: application/xml` ([08](08-crs-tcp-framing.md)) | `Host`, `Accept: application/xml`, `Content-Type: application/xml`, `Content-Length` |
| Заголовки ответа | `Content-Length`, `Content-Type: application/xml` ([08](08-crs-tcp-framing.md)) | `Date`, `Server: Apache/2.4…`, `Content-Type: application/xml`, `Content-Length` |
| Тело ответа | `Content-Length` | `Content-Length` (у ответов `crs`); chunked — у ошибок самого wsap (404) |
| Соединения | по одному на `openDevDepot` и на остальные вызовы | то же число; соединение переиспользуется неявно (HTTP/1.1), заголовков `Connection` и `Keep-Alive` в трафике Конфигуратора нет — в пробах стенд сам шлёт `Connection: close` |
| Аутентификация | `crs:auth` в теле | то же; заголовка `Authorization` нет |

Конфигуратор шлёт тело в UTF-8 с BOM в обоих транспортах. По http сервер принимает и запрос без BOM: `probe-no-bom` — тот же `openDevDepot` без BOM — дал `200` и тот же `call_return`, что `probe-valid`. Ответы `crs` приходят с BOM.

## Ошибки публикующего слоя и разбора

Пробы (`probe-*`; запросы собраны стендом, заголовки заданы явно и записаны как есть, ответы — настоящие; основа — реальный запрос `openDevDepot`):

| Проба | HTTP | Тело ответа |
|---|---|---|
| `probe-valid` — корректный `openDevDepot` | 200 | `crs:call_return` (438 байт, как у Конфигуратора); `Content-Type: application/xml` |
| `probe-no-bom` — то же без BOM | 200 | тот же `call_return` |
| `probe-wrong-path` — `/repo/missing.1ccr` | 404, chunked | `exception` (`xmlns` виртуальной ресурсной системы, `clsid` `580392e6-…`, `reason="404"`), в `descr` — «HTTP: Not found» и путь; внутри стек `wsap24:0x…` |
| `probe-get` — GET вместо POST | 406 | тот же `exception`, `reason="406"`, «HTTP: Not acceptable» |
| `probe-malformed-body` — тело не XML | 400 | `exception` типа `d1p1:Exception`, `clsid` `c593fe3b-…`, `descr` «Ошибка разбора XML … Document is empty», `data` — base64 скобочного текста; стек `xml2:…`, `crcore:…`, `crserver:…`: XML разбирал `crserver`, а wsap отдал его исключение со статусом 400 |
| `probe-wrong-alias` — несуществующий alias | 200 | `crs:call_exception`, `clsid` `3ccb2518-…` (тот же, что у неверного пароля!), текст «Хранилище конфигурации по адресу: crsdata/nosuch не обнаружено» |
| `probe-unknown-method` — несуществующий метод | 200 | пустое тело: 3 байта (один BOM), без `call_return` и без `call_exception` |

Заголовки ошибок: у 406 и 400 — `Content-Type: application/xml; charset=utf-8`, у 404 — `application/xml` и chunked, у ответов `crs` — `application/xml`. В пробах соединение закрывается по `Connection: close`, заданному стендом; поведение keep-alive у Конфигуратора — по его трафику (см. выше).

Следствия для клиента:

1. Различать ошибки нужно на трёх уровнях: HTTP-статус (404/406/400 — не `crs`, тело `exception`; 400 — ошибка
   разбора запроса на стороне `crserver`), тело `crs:call_exception` (статус 200) и пустое тело при 200
   (неизвестный метод).
2. По `clsid` `3ccb2518-…` нельзя отличить неверный пароль от отсутствующего хранилища — различает только
   текст исключения (позднее выяснено, что различает код — второй элемент корня, см.
   [05-crs-api.md](05-crs-api.md)).
3. Тело `exception` не является конвертом `crs`: разбирается отдельно (`clsid`, `reason`, `descr`), и его
   размер (стек) нужно ограничивать.

## Не проверено

- Https и аутентификация на уровне apache (Basic и т. п.): стенд без TLS и без авторизации apache.
- Большие тела (помещение, создание хранилища): ограничения `LimitRequestBody` и поведение при chunked-запросе.
- Ответы для методов истории и пользователей по http: история объекта снята (iljyxa/vscode-1c-repository-tools#89,
  `example/crs/8.5.1/http/probe-history-*`, ответы идентичны tcp, см. [06-crs-history.md](06-crs-history.md));
  полная история, прочие фильтры и список пользователей — нет.
- Другие версии платформы: wsap другой версии, чем crserver.

(Рукопожатие по версии по http проверено 2026-09-30, см. ниже.)

## Сырые пробы http (2026-09-30, iljyxa/vscode-1c-repository-tools#15)

Платформа 8.5.1.1529, тот же стенд. Пробы `http/probe-*` сохраняли тело ответа уже раскодированным (границы
chunk терялись), а версию и alias по http не проверяли. Поэтому пробы повторены сырым запросом через `net`:
`node fixtures/tools/capture-http-raw.mjs` исходного проекта, результат — `example/crs/8.5.1/http-raw/<проба>/`
(`request.bin`, `response.bin` — байты целиком, `result.json`; описание — [example/crs/README.md](../../../example/crs/README.md)).
Основа запроса — тело `openDevDepot` из `tcp-raw/wrong-password`, заголовки — как в `http/probe-valid`.
Ответ читается до закрытия соединения сервером (`Connection: close`).

| Проба | HTTP | Ответ |
|---|---|---|
| `probe-valid` | 200 | 438 байт, `Content-Length` |
| `probe-wrong-path` | 404 | chunked, один chunk `44e`, тело — исключение VRS |
| `probe-malformed-body` | 400 | исключение VRS (`exception`) |
| `probe-unknown-method` | 200 | 3 байта (BOM) |
| `probe-wrong-alias` | 200 | `call_exception` |
| `probe-version-zero` | 200 | `call_exception`, код 17 |
| `probe-version-zero-wrong-alias` | 200 | `call_exception` (версия проверяется раньше alias) |
| `probe-version-other` | 200 | `call_exception`, код 17 |

Выводы:

- **Версия.** wsap24 пропускает `version="0.0.0.0"`: статус 200. Тела трёх проб версии побайтно совпадают
  с телами `tcp-raw/probe-version-*` («Несоответствие версий… Версия сервера: 8.5.1.1529»). Рукопожатие
  по http идёт тем же путём, что по tcp: расхождений нет.
- **Порядок проверок** как у tcp: версия раньше alias.
- **Chunked.** 404 публикации приходит chunked; prefork-apache отвечает с `Connection: close`.
- Остальные пробы дали те же статусы и тела, что `http/probe-*`.

Клиент (`CrsHttpTransport`) — [repository-crs.md](../../repository-crs.md).
