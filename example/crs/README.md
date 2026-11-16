# Снятый трафик crserver

> Корпус перенесён без изменений байтов из проекта [vscode-1c-repository-tools](https://github.com/iljyxa/vscode-1c-repository-tools)
> (коммит `8391ab0`, каталог `fixtures/crs/8.5.1`). Скрипты съёмки (`fixtures/tools/*.mjs`) и стенд с настоящим
> `crserver` пока остались в исходном проекте — их перенос: issue #118. Номера issues ниже (`issue #N`) относятся
> к исходному проекту. Тесты в `example/` не пишут.


Настоящие кадры обмена Конфигуратора с `crserver` (тела `crs:call` / `crs:call_return` /
`crs:call_exception`), снятые записывающим tcp-прокси стенда `fixtures/tools/`. Байты не правятся:
нужен другой сценарий — дописывается скрипт и каталог пересобирается.

Раскладка: `<версия платформы>/tcp/<сценарий>/NN-conn-CC-<c2s|s2c>-<метод>.xml`, где `CC` — номер
соединения. Нумерация идёт сначала по запросам соединения, затем по его ответам; ответы соединения
следуют в порядке запросов. `result.json` сценария — команда Конфигуратора, пользователь, код возврата
и вывод платформы. Имя машины в кадрах заменено на `crs-stand`, рабочий каталог — на
`/tmp/crs-stand/work`.

## Захват и отпуск (`tcp/`, платформа 8.5.1, issue iljyxa/vscode-1c-repository-tools#9)

Сборка: `node fixtures/tools/capture-locks.mjs` (около минуты; нужны платформа с `crserver` и `xvfb-run`).
Объекты — `fixtures/config`; пользователи `Petrov`, `Sidorov` (`LockObjects`) и `Reader` (`ReadOnly`)
привязаны каждый к своей базе.

| Сценарий | Что происходит | Итог |
|---|---|---|
| `lock-one` / `unlock-one` | захват и отпуск `Справочник.Контрагенты` | успех, `DevDepot_reviseDevObjects` |
| `lock-several` / `unlock-several` | то же для двух объектов | успех, один вызов на оба |
| `lock-held-by-other` | Sidorov захватывает объект, захваченный Petrov | код 1; вызов есть, отказ приходит в `call_return` |
| `unlock-held-by-other` | Sidorov отпускает чужой захват | код 0; вывод платформы называет владельца |
| `lock-no-right` | Reader (`ReadOnly`) захватывает объект | код 1; Конфигуратор не доходит до `reviseDevObjects`: права приходят в `crs:userInfo` ответа `DevDepot_authenticate` (`crs:rights`: 65535 — Admin, 3 — `LockObjects`, 0 — `ReadOnly`) и отказывает сам клиент, кадра отказа нет |
| `lock-wrong-password` | неверный пароль Petrov | код 1; `call_exception` на `DevDepot_authenticate`; две попытки, каждая — пара `openDevDepot` + `authenticate` на отдельных соединениях (четыре соединения) |
| `lock-unknown-user` | несуществующий пользователь | то же, что неверный пароль: сервер их не различает |

`locks-summary.json` — сводка кодов возврата и вывода по сценариям захвата. Скрипт пересобирает только свои каталоги сценариев, чужие фикстуры в `tcp/` не трогает.

## История версий (`tcp/history-*`, платформа 8.5.1, issue iljyxa/vscode-1c-repository-tools#10)

Сборка: `node fixtures/tools/capture-history.mjs`. В хранилище помещаются версии 2–6 (версия 1 — создание):
две от Petrov (в третьей — два объекта), одна от Admin с комментарием из двух строк; метки — на версиях 2
и 4; затем от Admin версия 5 без комментария (ключ `-comment` не передаётся) и версия 6 с комментарием
`Спецсимволы: <тег> & 'апостроф' > конец` (issue iljyxa/vscode-1c-repository-tools#21; двойную кавычку командная строка Конфигуратора
обрезает, поэтому её в комментарии нет). Затем через прокси снимается `/ConfigurationRepositoryReport` (формат `txt`); `report.txt` рядом с
кадрами — то, что Конфигуратор построил из ответа, эталон для проверки разбора (в нём дата отчёта и порт
прокси меняются от прогона к прогону). Разбор кадров — [06-crs-history.md](../../docs/research/crs/06-crs-history.md).

| Сценарий | Ключи отчёта | Что отличается в запросе `DevDepot_devDepotReport` |
|---|---|---|
| `history-all` | — | фильтр без ограничений (`-1`, `0001-01-01T00:00:00`) |
| `history-range` | `-NBegin 2 -NEnd 3` | `beginVerNum=2`, `endVerNum=3` |
| `history-by-date` | `-DateBegin 2000-01-01 -DateEnd 2100-01-01` | `beginDate`, `endDate`; в ответе все версии |
| `history-by-date-future` | `-DateBegin 2100-01-01` | `beginDate`; ответ без версий (фильтр дат работает на сервере) |
| `history-only-labels` | `-IncludeOnlyVersionsWithLabels` | `onlyLabels=true` |
| `history-no-labels` | `-DoNotIncludeVersionsWithLabels` | `labels=false` |
| `history-by-object`, `history-by-comment` | `-GroupByObject`, `-GroupByComment` | ничем: группировка на стороне клиента |
| `history-empty-comment` | `-NBegin 5 -NEnd 5` | `beginVerNum=endVerNum=5`; в ответе `<crs:comment/>` |
| `history-special-comment` | `-NBegin 6 -NEnd 6` | `beginVerNum=endVerNum=6`; в ответе `&lt;`, `&gt;`, `&amp;` в тексте комментария |

От пересборки к пересборке меняются uuid пользователей и версий, даты и хеши версий: тесты их не
хардкодят, а берут из ответов и `report.txt`.

Сводка — `history-summary.json`. Скрипт `capture-history.mjs` удаляет только каталоги своих сценариев.

### История со всей тестовой конфигурацией (`history-full-config`, issue iljyxa/vscode-1c-repository-tools#84)

Сборка: `node fixtures/tools/capture-history-classes.mjs`. Хранилище создаётся из `fixtures/config` (объект
каждого вида, issue iljyxa/vscode-1c-repository-tools#49) без дополнительных версий, снимается отчёт версии 1: все 57 объектов с их `classID`.
Имена объектов (`Тест<Вид>`) задают вид, а `report.txt` — русское название класса, по которому сверяется
таблица `classID` → вид. Дочерние элементы (измерения, ресурсы) отдельными объектами в истории не приходят:
только объекты, формы и макеты. Отдельно от `capture-history.mjs`, чтобы пересъёмка не меняла остальные сценарии.
Сводка — `history-classes-summary.json`.

## Http (`http/`, платформа 8.5.1, issue iljyxa/vscode-1c-repository-tools#11)

Сборка: `node fixtures/tools/capture-locks.mjs --transport=http` — те же девять сценариев захвата и отпуска,
что и по tcp (одни и те же имена каталогов), но Конфигуратор ходит на `http://127.0.0.1:<порт>/repo/repo.1ccr/exp`
через записывающий прокси на собственный apache с `wsap24.so`; нужен `/usr/sbin/apache2`. Разница с tcp —
[07-crs-http.md](../../docs/research/crs/07-crs-http.md).

Раскладка та же, что у tcp, плюс для каждого кадра `NN-….headers.txt` — заголовки HTTP-сообщения (в них
`Host` с портом прокси и `Date` меняются от прогона к прогону). Каталоги `probe-*` — пробы публикации: запрос
собран стендом, ответ настоящий (`request.{headers.txt,xml}`, `response.{headers.txt,xml}`); сюда попали
корректный запрос, запрос без BOM, неверный путь, GET, не-XML, несуществующий alias и метод (заголовки проб записаны такими, какими стенд их отправил, `Connection: close`). `locks-summary.json` — сводка.

История версий по http (issue iljyxa/vscode-1c-repository-tools#82): `node fixtures/tools/capture-history.mjs --transport=http` — те же десять
сценариев `history-*` и то же хранилище, что по tcp (подготовка идёт по tcp), но Конфигуратор ходит через
апач; в каждом сценарии, как и по tcp, есть `devDepotReport` и `depotUsers`. Хранилище собирается из
сегодняшней `fixtures/config`, поэтому версия 1 содержит все объекты (issue iljyxa/vscode-1c-repository-tools#49), в отличие от снятых ранее
по tcp сценариев; ответы по tcp и http поэтому побайтно не сравниваются. Сводка — `history-summary.json`.

## Сырые пробы http (`http-raw/`, платформа 8.5.1, issue iljyxa/vscode-1c-repository-tools#15)

Сборка: `node fixtures/tools/capture-http-raw.mjs` (нужны платформа с `crserver`, `xvfb-run` и apache с
`wsap24.so`). В отличие от `http/`, ответы лежат побайтно: с границами chunk и заголовками, без замен.
Стенд (`stand.httpRawProbe`) шлёт сырой запрос через `net` на порт apache и читает ответ до закрытия
соединения сервером (запрос с `Connection: close`); потоки проверяются `assertRawClean`. Основа запроса —
тело `openDevDepot` из `tcp-raw/wrong-password/conn-01.c2s.bin`, заголовки — как в `http/probe-valid`.

`http-raw/<проба>/`: `request.bin`, `response.bin` (байты целиком), `result.json`. Пробы: `probe-valid`,
`probe-wrong-path` (404, chunked), `probe-malformed-body` (400), `probe-unknown-method` (200, 3 байта BOM),
`probe-wrong-alias`, `probe-version-zero`, `probe-version-zero-wrong-alias`, `probe-version-other`. Тела
проб версии побайтно совпадают с `tcp-raw/probe-version-*`. Сводка — `http-raw-summary.json`; разбор —
[07-crs-http.md](../../docs/research/crs/07-crs-http.md), раздел 2026-09-30. От пересборки к пересборке
меняются `Date`, `depotID`/`rootID`, `crs:date` и порт apache в `Host` каждого `request.bin` (порт
случайный; при другом числе цифр меняется и `requestBytes` в `result.json` и сводке). Тесты от порта не
зависят: из `request.bin` берётся только тело. Скрипт пересобирает только свои каталоги в `http-raw/`.

## Сырые tcp-потоки и пробы транспорта (`tcp-raw/`, платформа 8.5.1, issue iljyxa/vscode-1c-repository-tools#46)

Сборка: `node fixtures/tools/capture-tcp-raw.mjs` (около минуты). Здесь, в отличие от `tcp/`, потоки
лежат побайтно, без нарезки на кадры и без замен: имя машины и путь рабочего каталога стенд не
подменяет (замена сломала бы `Content-Length`), а при их появлении в потоке падает. Поэтому сценарии
выбраны без `DevDepot_bind` — в нём есть имя машины. Разбор байт — [08-crs-tcp-framing.md](../../docs/research/crs/08-crs-tcp-framing.md).

Сценарии Конфигуратора (`wrong-password`, `wrong-password-rerun` — неверный пароль Petrov, тот же
`/ConfigurationRepositoryLock` двумя разными процессами `1cv8`): `conn-NN.c2s.bin` / `conn-NN.s2c.bin` —
всё, что прошло через прокси в каждую сторону; `conn-NN.order.json` — последовательность
`{dir, bytes}` в порядке прихода данных и `{dir, end: true}` — кто первым закрыл свою сторону (FIN).
Подряд идущие куски одного направления слиты: их дробление — случайность tcp, а не протокол.
`result.json` — как у `tcp/`.

Пробы (`probe-*`): запрос собирает стенд из снятых приветствия клиента и кадра `openDevDepot`
(`conn-01.c2s.bin` сценария `wrong-password`), меняя только тело и `Content-Length`; ответ — настоящий
ответ `crserver`. Стенд ждёт приветствие сервера, шлёт приветствие клиента и первый кадр, следующую
запись — после паузы сервера (1 с, у `probe-no-terminator` и `probe-late-terminator` — 3 с), затем закрывает сокет сам.
`request.bin` / `response.bin` — байты целиком (в `response.bin` — и приветствие сервера),
`order.json` — как выше, но записи стенда не сливаются (пауза между ними — суть пробы), `result.json` —
размеры и закрыл ли сервер соединение.

| Проба | Запрос | Ответ |
|---|---|---|
| `probe-open` | приветствие + кадр `openDevDepot` как у Конфигуратора | `200 OK`, `call_return`, как у Конфигуратора |
| `probe-two-frames` | два таких кадра в одном соединении, второй — после ответа на первый | два ответа `200 OK`, одно приветствие сервера |
| `probe-no-terminator` | кадр без `6653b2a6` | только приветствие сервера: за 3 с ответа нет |
| `probe-late-terminator` | кадр без терминатора, через 3 с — терминатор отдельной записью | `200 OK` после терминатора |
| `probe-malformed-body` | тело «не xml» | `400 Bad request`, `exception` (ошибка разбора XML) |
| `probe-unknown-method` | `DevDepot_noSuchMethod` | `200 OK`, тело — один BOM |
| `probe-no-hello` | кадр без приветствия клиента | `200 OK`, тот же ответ, что `probe-open` |
| `probe-version-zero` | `openDevDepot` с `version="0.0.0.0"` (issue iljyxa/vscode-1c-repository-tools#13) | `call_exception`, clsid `3ccb2518`, код 17, в тексте версия сервера 8.5.1.1529 |
| `probe-version-zero-wrong-alias` | `0.0.0.0` и несуществующий alias | тот же отказ о версии: версия проверяется раньше alias |
| `probe-version-other` | версия `8.3.27.2342` | тот же отказ (код 17): версия нужна точная |
| `probe-wrong-alias` | верная версия, alias `nosuch` | `call_exception`, clsid `3ccb2518`, код 1; парна `http/probe-wrong-alias` |

Пробы версии и alias подставляются в снятый кадр `openDevDepot` функцией `substitute` скрипта: она бросает
ошибку, если образец замены встретился не ровно один раз. На них построены рукопожатие и классификация
отказов `src/infra/repository/crs/` ([05-crs-api.md](../../docs/research/crs/05-crs-api.md), решение 7 в [repository-crs.md](../../docs/repository-crs.md)).

`tcp-raw-summary.json` — сводка. От пересборки к пересборке меняются только UUID клиента (16 байт после
`224855b5`), `depotID`/`rootID` хранилища и `crs:date` в ответе `openDevDepot`; размеры потоков и
`order.json` совпадают. Скрипт пересобирает только каталоги своих сценариев в `tcp-raw/`.

## Пробы методов чтения (`tcp/probe-*`, платформа 8.5.1, issue iljyxa/vscode-1c-repository-tools#14)

Сборка: `node fixtures/tools/capture-read-probes.mjs` (около минуты). Пробы снимаются на уровне тел, а не
сырым потоком, как в `tcp-raw/`: в ответах `bindInfos` есть `bindString` с именем машины, а сырой режим при
его появлении падает. Помощник `stand.tcpBodyProbe` шлёт кадр (приветствие и заголовок берутся из
подготовительного шага), читает ответ по `Content-Length`, прогоняет тело через `scrub` и пишет
`request.xml`, `response.xml`, `result.json`. Запросы собираются подстановкой в снятые тела (образец замены
должен встретиться ровно один раз). Стенд — как в захвате: Petrov захватывает `Справочник.Контрагенты`,
Sidorov, Reader привязаны к своим базам. Тела `devDepotReport` и `depotUsers` для проб истории берутся из
потоков подготовительного `/ConfigurationRepositoryReport` от Petrov.

| Проба | Запрос | Итог |
|---|---|---|
| `probe-statistic-no-bind` | полная статистика Petrov без `crs:bind` | ответ как с привязкой |
| `probe-statistic-random-bind` | то же со случайным `bindID` | тот же ответ |
| `probe-statistic-own-bind` | с настоящим `bindID` Petrov, свежее соединение без `authenticate` | контроль |
| `probe-statistic-reader-no-bind` | Reader без привязки | тот же ответ |
| `probe-statistic-wrong-password` | неверный хеш Petrov | `auth-failed`, код 4 |
| `probe-history-no-bind` | `devDepotReport` Petrov без `crs:bind` (issue iljyxa/vscode-1c-repository-tools#21) | история как у Конфигуратора |
| `probe-history-random-bind` | то же со случайным `bindID` | тот же ответ |
| `probe-history-reader-no-bind` | Reader (`ReadOnly`) без привязки | тот же ответ |
| `probe-history-wrong-password` | неверный хеш Petrov | `auth-failed`, код 4 |
| `probe-depot-users-no-bind` | `UserManager_depotUsers` Petrov без `crs:bind` | список пользователей |
| `probe-depot-users-reader-no-bind` | то же от Reader (`ReadOnly`) | тот же список |
| `probe-bind-unknown-existing` | `bind` случайного `bindID`, `existing=true` | отказ, код 11 |
| `probe-bind-new` | `bind`, `existing=false`, `force=false` | отказ, код 10; привязка не появилась |
| `probe-statistic-after-bind-new` | статистика после предыдущей | `bindInfos` без новой записи |

`probe-bind-new` меняет состояние стенда, поэтому в порядке снятия идёт предпоследней (за ней — только
проверочная статистика). `read-probes-summary.json` — сводка. Скрипт пересобирает только свои каталоги
`probe-*` в `tcp/`. Выводы — [05-crs-api.md](../../docs/research/crs/05-crs-api.md), решение 8 в
[repository-crs.md](../../docs/repository-crs.md).

## Пробы фильтров истории (`tcp/probe-history-*`, платформа 8.5.1, issue iljyxa/vscode-1c-repository-tools#39)

Сборка: `node fixtures/tools/capture-history-probes.mjs` (несколько минут). Хранилище — те же версии 1–6, что
у `capture-history.mjs` (общий модуль `history-repository.mjs`), и версия 7 от Admin со свойством «Версия»
конфигурации `1.0.0.2` (помещён только корень). Пробы — как в разделе выше (`stand.tcpBodyProbe`): тело —
снятый `devDepotReport` Admin без `crs:bind`, в нём подстановкой меняются только поля фильтра. uuid авторов,
объектов и дата версии 3 берутся из ответа контрольной пробы `probe-history-filter-none`.

| Группа | Пробы | Что проверяется |
|---|---|---|
| авторы | `user-petrov`, `user-both`, `user-unknown`, `user-petrov-mask-1` | `userIDs` при `mask=2` и без бита |
| объекты | `object-catalog`, `object-catalog-recursive`, `object-form`, `object-root`, `object-root-recursive`, `object-two`, `object-unknown`, `object-catalog-mask-1` | `objRefs`, `recursive` при `mask=4` и без бита |
| сочетания | `object-catalog-user-petrov` (`mask=6`), `object-catalog-range` (`mask=5`), `object-catalog-only-labels` | фильтры по «и» |
| маска | `mask-0`, `mask-0-range`, `mask-2-no-users`, `mask-4-no-objects`, `mask-8` | биты без списков, неизвестный бит |
| версия конфигурации | `config-version-1`, `config-version-2`, `config-version-2-mask-0`, `config-version-unknown` | `configVersion` |
| даты | `date-exact`, `date-begin-after`, `date-end-at`, `date-end-before`, `date-future-mask-0` | границы по дате версии 3 ± 1 с |
| метод crs-api | `devdepotversions`, `devdepotversions-object-two`, `devdepotversions-user-petrov`, `devdepotversions-crs-api` | `DevDepot_devDepotVersions` с фильтром Конфигуратора и в записи crs-api |
| страницы и списки (issue iljyxa/vscode-1c-repository-tools#83) | `devdepotversions-object-catalog-recursive`, `devdepotversions-object-root-recursive`, `devdepotversions-object-unknown`; `page-1-7`, `page-5-7`, `page-2-4`, `page-1-1` (`mask=1`), `page-object-catalog-recursive-3-6`, `-1-2`, `-1-6`, `page-object-root-recursive-5-7`, `-1-7` (`mask=5`) | постраничная история: список номеров по фильтру объекта с подчинёнными (справочник — 1, 2, 3, 6; неизвестный объект — пустой `<crs:versions/>`) и отчёт по диапазону `beginVerNum..endVerNum` из реальных номеров списка |

`history-probes-summary.json` — по каждой пробе вид ответа, номера версий в порядке ответа (с повторами) и
изменённые объекты `<версия>:<имя>`, у отказа — текст исключения. От пересборки к пересборке меняются uuid и
даты (и дата версии 3 в запросах проб дат). Скрипт пересобирает только свои каталоги `probe-history-*`; пробы
привязки истории (`probe-history-no-bind` и др.) — за `capture-read-probes.mjs`. Выводы —
[06-crs-history.md](../../docs/research/crs/06-crs-history.md), раздел «Фильтры истории».

Режим `--transport=http` (issue iljyxa/vscode-1c-repository-tools#89): `node fixtures/tools/capture-history-probes.mjs --transport=http` снимает
через публикацию `.1ccr` только пробы истории объекта и постраничной загрузки (`HTTP_PROBES`):
`http/probe-history-filter-none`, `-object-catalog`, `-object-catalog-recursive`, `-object-two`, `-object-unknown`,
`-devdepotversions`, `-devdepotversions-object-two`, `-devdepotversions-object-catalog-recursive`,
`-devdepotversions-object-unknown`, `-devdepotversions-object-root-recursive` и все `-page-*`; сводка — `http/history-probes-summary.json`. Состав ответов (номера версий, изменённые
объекты, повторы версий, пустой список) совпадает с tcp; побайтно они не равны: tcp и http снимаются отдельными
сборками хранилища, поэтому uuid и даты разные. Нужны apache с `wsap24.so` (как для `capture-locks.mjs --transport=http`). Скрипт пересобирает
только свои каталоги `probe-history-*` в `http/`.
