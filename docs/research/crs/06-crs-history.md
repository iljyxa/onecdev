> Исследование перенесено из проекта [vscode-1c-repository-tools](https://github.com/iljyxa/vscode-1c-repository-tools)
> (коммит `8391ab0`, `docs/research/06-crs-history.md`) без изменения выводов; текст датирован. Номера
> `iljyxa/vscode-1c-repository-tools#N` относятся к исходному проекту; `core/crs/history.ts` исходника в onecdev —
> `src/infra/repository/crs/CrsHistory.ts`, сервис истории (`core/repository/historyService.ts`, таблица
> `metadataClasses.ts`) появится на этапе 2 (iljyxa/onecdev#117). Принятые для onecdev решения —
> [repository-crs.md](../../repository-crs.md); трафик — `example/crs/` ([README](../../../example/crs/README.md)).

# История версий хранилища по протоколу `crs`

Дата: 2026-09-29. Платформа 8.5.1.1529, tcp. Источник — трафик Конфигуратора при
`/ConfigurationRepositoryReport`, снятый скриптом `capture-history.mjs` исходного проекта; кадры лежат в
`example/crs/8.5.1/tcp/history-*/` (описание сценариев — [example/crs/README.md](../../../example/crs/README.md)).
Гипотезы из [05-crs-api.md](05-crs-api.md) проверены на реальном обмене; расхождения отмечены ниже.

## Как снято

Хранилище из `fixtures/config` исходного проекта: версия 1 — создание (Admin), версии 2 и 3 — Petrov, версии 4–6 — Admin;
у версии 4 комментарий из двух строк, у версии 5 комментария нет, у версии 6 — спецсимволы
(`<тег> & 'апостроф' >`), в версии 3 два изменённых объекта, метки на версиях 2 и 4. Десять вариантов отчёта:
все версии, диапазон номеров, группировка по объектам и по комментариям, только версии с метками, только без
меток, диапазон дат, дата в будущем, версия 5 (пустой комментарий) и версия 6 (спецсимволы). Формат отчёта — `txt`;
рядом с кадрами лежит `report.txt` — то, что Конфигуратор построил из ответа сервера (эталон для
проверки разбора).

Пересъёмка (2026-09-30, iljyxa/vscode-1c-repository-tools#21): в сценарий добавлены версии 5 и 6, все `history-*` сняты заново — uuid и даты
отличаются от первой съёмки (цифры и примеры ниже приведены по текущим фикстурам), тесты их не хардкодят.
Двойная кавычка в комментарии обрезает его в командной строке Конфигуратора, поэтому в версии 6 её нет.

## Порядок вызовов

Соединения отчёта (`history-all/`): `openDevDepot` (конн. 1) → `authenticate`, `depotInfo`, `bind`,
`devObjectsStatistic`, **`DevDepot_devDepotReport`** (конн. 2) → `UserManager_depotUsers` (конн. 3).
`crs:auth` есть у `depotInfo`, `bind`, `devObjectsStatistic`, `devDepotReport` и `depotUsers`; в `authenticate` учётные данные — в `params`, в `openDevDepot` — ничего. `crs:bind` (тот же `bindID`, что в `bind`) есть только у `devObjectsStatistic`, `devDepotReport` и `depotUsers`.

## Метод истории — `DevDepot_devDepotReport`

Расхождение с crs-api: Конфигуратор 8.5.1 вызывает не `DevDepot_devDepotVersions`, а
`DevDepot_devDepotReport`. Параметр — тот же `crs:filter`:

```xml
<crs:filter>
  <crs:mask value="1"/>
  <crs:beginDate value="0001-01-01T00:00:00"/>  <!-- «нет» = 0001-01-01T00:00:00 -->
  <crs:endDate value="0001-01-01T00:00:00"/>
  <crs:beginVerNum value="-1"/>                  <!-- «нет» = -1, а не 4294967295 -->
  <crs:endVerNum value="-1"/>
  <crs:userIDs/><crs:objRefs/>
  <crs:recursive value="false"/>
  <crs:labels value="true"/>
  <crs:onlyLabels value="false"/>
  <crs:configVersion value=""/>
  <crs:externals/><crs:noExternals/>
</crs:filter>
```

Соответствие ключей отчёта полям фильтра (значения из кадров `07-…devDepotReport.xml`):

| Ключ `/ConfigurationRepositoryReport` | Поле фильтра |
|---|---|
| `-NBegin 2 -NEnd 3` | `beginVerNum=2`, `endVerNum=3` (значения атрибутами `value`, не текстом) |
| `-DateBegin`/`-DateEnd` | `beginDate`/`endDate` в ISO без пояса: `2000-01-01T00:00:00`; сервер фильтрует: `-DateBegin 2100-01-01` даёт пустой ответ (`history-by-date-future`), диапазон 2000–2100 — все версии |
| `-IncludeOnlyVersionsWithLabels` | `onlyLabels=true`: в ответе только версии с метками (2 и 4) |
| `-DoNotIncludeVersionsWithLabels` | `labels=false`: версии с метками исключены (остались 1, 3, 5 и 6), элементов `label` нет |
| `-GroupByObject`, `-GroupByComment` | **в запросе ничего не меняют** — запрос и ответ те же, группировка выполняется клиентом |

Следствие: история по объектам строится клиентом из одного ответа. Фильтры `userIDs`, `objRefs`,
`recursive`, `configVersion`, смысл `mask` этим сценарием не проверяются — ключей Конфигуратора для них нет;
они сняты пробами, см. раздел «Фильтры истории» ниже.

## Ответ — `call_return` с `crs:data`

Содержит три раздела.

**`objectVersions`** — версии хранилища; элемент `value`:

| Поле | Смысл | Пример |
|---|---|---|
| `info/verNum` | номер версии | `2` |
| `info/userID` | uuid автора (имя — из `UserManager_depotUsers`) | |
| `info/date` | дата помещения без пояса (стенд работает в UTC, соответствие поясу не проверялось) | `2026-09-30T13:09:13` |
| `info/code` | версия конфигурации (свойство «Версия») | `1.0.0.1` |
| `info/cvermajor`, `cverminor` | внутренняя версия формата конфигурации | `216`, `0` |
| `info/pvermajor`, `pverminor`, `pverbuild`, `pverrevis` | версия платформы, которой помещено | `8`, `5`, `1`, `1529` |
| `info/comment` | комментарий как текст узла, переводы строк сохранены (`\n`); пустой комментарий — `<crs:comment/>` (версия 5); `<`, `>`, `&` экранированы (версия 6) | |
| `info/versionID` | uuid версии | |
| `label` (необязателен) | метка версии; в `label`: `verNum`, `userID` автора метки, `date` установки метки, `name`, `comment` | `Релиз 1.0`, `Первый релиз` |

Поля `file` (в crs-api описано как «данные конфигурации») нет: содержимое конфигурации в ответе не
приходит, размер ответа определяется числом версий и изменённых объектов. Версия 1 (создание хранилища)
приходит с `verNum=1`; в ней же перечислены все 9 объектов конфигурации.

**`depotVersions`** — состав изменений: по элементу на пару «объект × версия, в которой он менялся».
Элемент `value`:

| Поле | Смысл |
|---|---|
| `info/_super/id`, `classID` | uuid объекта и его класса |
| `info/name` | имя (у корня конфигурации — имя конфигурации, у остальных — короткое имя) |
| `info/pos` | позиция объекта среди однотипных (`0`, у `Справочник.Номенклатура` — `1`) |
| `info/verNum` | номер версии хранилища, в которой объект изменён |
| `info/selfVerNum` | собственный счётчик версий объекта (у общего модуля в версии 4 — `3`) |
| `info/parentID`, `ownerID` | родитель в дереве метаданных (uuid корня `ТестовоеХранилище` у объектов верхнего уровня) и владелец |
| `info/version/original`, `local` | хеш версии объекта (внутренний, не разбирается) |
| `info/removed` | объект удалён |
| `action` | `0` — добавлен (версия 1, 9 элементов), `5` — изменён (6 элементов в версиях 2–6) |
| `fullName/fullName`, `isDecoded` | у корня — имя; у остальных — путь `<classID>.<имя>` (у дочерних — цепочка `<classID родителя>.<имя родителя>.<classID>.<имя>`), `isDecoded=false` |
| `externals/value` | есть у объектов с модулем, формой или макетом (у `Справочник.Номенклатура` пусто): `name` вида `<uuid объекта>.0`, `verID` — версия блока данных; смысл установлен по совпадению с составом объектов, содержимое не разбирается |

Имена вида «Справочник.Контрагенты» в отчёте Конфигуратор получает сам по `classID`; для подписей
клиенту нужна таблица `classID` → вид объекта (для нашей конфигурации: `cf4abea6-…` — справочник,
`0fe48980-…` — общий модуль, `37f2fa9a-…` — подсистема, `09736b02-…` — роль, `9cd510ce-…` — язык,
`cf4abeab-…` — корень конфигурации, `fdf816d2-…` — форма, `3daea016-…` — макет); классы остальных видов
сняты на `fixtures/config` исходного проекта с объектом каждого вида (сценарий `history-full-config`,
iljyxa/vscode-1c-repository-tools#84) и сведены в `metadataClasses.ts` исходника. Дочерние объекты
(форма, макет) приходят отдельными элементами версии 1 с `parentID` = uuid справочника, а не корня; в
`report.txt` они названы `Справочник.Контрагенты.Форма.ФормаЭлемента`. При изменении модуля объекта в
версии приходит только сам объект (`Справочник.Контрагенты`), без формы и макета.

**`processOrder`** — массив `value`; число значений равно числу элементов `objectVersions` плюс `depotVersions` (6 + 15 = 21 в `history-all`): `0` на каждую версию, `1` на каждый изменённый объект. Порядок обработки, разбору не подлежит.

## Имена пользователей

Список пользователей (включая удалённых) в 8.5.1 приходит в двух местах, в одном формате:
в ответе `DevDepot_devObjectsStatistic` (запрос с `<crs:objRefs/><crs:removed value="true"/>`, рядом
`statMap` и `bindInfos`) — так и утверждает crs-api, — и в ответе отдельного `UserManager_depotUsers` с
`<crs:removed value="true"/>`, который Конфигуратор вызывает после отчёта. Формат:
`crs:users/value/{first=<uuid>, second/{info/{id,name,password(md5),rights}, online, removed}}`. Права
проверены на стенде: `65535` — Admin, `3` — `LockObjects`, `0` — `ReadOnly`; в таблице crs-api другие
значения (`1`, `5`, `32773`), вероятно, для 8.3.x — не проверялось.

## Для клиента (шаг 2)

1. История запрашивается `DevDepot_devDepotReport` с фильтром «без ограничений»: `-1` и
   `0001-01-01T00:00:00`. Диапазоны номеров, даты и метки фильтруются сервером (проверено); группировки — клиент.
2. Ответ содержит всё нужное панели: номер, автор (имя — из списка пользователей), дата, комментарий, метка, версия
   конфигурации и платформы, состав изменённых объектов. Содержимого объектов нет — запрет содержимого
   объектов ([repository-crs.md](../../repository-crs.md)) соблюдается без масок.
3. Лимит размера ответа нужен по-прежнему: `depotVersions` растёт с числом версий × изменённых объектов
   (первая съёмка: 4 версии на 9 объектов — 14 КБ; сейчас 6 версий и 15 элементов, размер не пересчитывался).
   В клиенте исходного проекта лимит 128 МиБ и дедлайн 120 с ([repository-crs.md](../../repository-crs.md)): история
   корня с `recursive` равна полной истории.
4. Ответ обёрнут в `<crs:data>`, но это открытый XML с метаданными, а не base64-содержимое объектов из
   [04-crs-protocol.md](04-crs-protocol.md). Запрет и sanity-чек исходного проекта, сформулированные по
   подстроке `crs:data`, запрещали такой клиент — уточнены (iljyxa/vscode-1c-repository-tools#38): `crs:data`
   допустим только в читателе истории (в onecdev — `src/infra/repository/crs/CrsHistory.ts`,
   [repository-crs.md](../../repository-crs.md)).
5. Комментарии и имена в XML — обычный текст (`&`, `<` экранируются); переводы строк сохраняются.

## Не проверено

- http (публикация `.1ccr`): захват, отпуск ([07-crs-http.md](07-crs-http.md)) и история объекта (#89, раздел
  «Http» ниже) сняты; полная история (10 сценариев `history-*`, #82) и список пользователей `depotUsers` тоже; диапазон номеров
  (`history-range`) и даты Конфигуратора (`history-by-date*`) по http сняты вместе с полной историей; фильтры,
  которых Конфигуратор не задаёт (авторы, `configVersion`, границы дат), по http пробами не снимались. Тела
  запросов от транспорта не зависят; ответы по http и tcp побайтно не сравниваются, потому что сняты на
  разных по составу хранилищах (см. `example/crs/README.md`).
- Сочетание `recursive` с несколькими объектами, где потомок сам отобран (схлопывание версий проверено только
  на снятых сочетаниях).
- Платформа 8.3.x: все пробы фильтров сняты на 8.5.1. Метод `DevDepot_devDepotVersions` на 8.3.x не проверен:
  клиент при `unknown-method` на списке откатывается на один `devDepotReport` целиком, но
  реальный ответ сервера без метода не снят — условие отката предположено по классификации отказов.
- Биты `mask` старше `4`: у бита `8` на стенде влияния не видно (`probe-history-mask-8`), что он включает — не
  выяснено. Фильтры `externals`/`noExternals` не пробовались.
- Объект, удалённый из конфигурации, в фильтре `objRefs` и его место в ответе.

Закрыто пробами (разделы ниже): привязка для истории и пользователей не нужна (#14, #21); `devDepotVersions`,
фильтры `userIDs`, `objRefs`, `recursive`, `configVersion`, смысл `mask` и границы дат (#39).

## Проверка `bind` для истории и пользователей (2026-09-30, iljyxa/vscode-1c-repository-tools#21)

Пробы уровня тел на `crserver` 8.5.1.1529 (`example/crs/8.5.1/tcp/probe-history-*`,
`probe-depot-users-*`, скрипт `capture-read-probes.mjs` исходного проекта; тела, а не сырой поток — в
`bindInfos` ответов есть имя машины). Запрос — снятый кадр Конфигуратора, меняется только `crs:bind`.

- `DevDepot_devDepotReport` без `crs:bind` (`probe-history-no-bind`) и со случайным `bindID`
  (`probe-history-random-bind`) — `call_return` с историей, как у Конфигуратора.
- От пользователя `ReadOnly` (Reader) без привязки (`probe-history-reader-no-bind`) — тот же ответ: права
  на чтение истории достаточно.
- `UserManager_depotUsers` без `crs:bind` (`probe-depot-users-no-bind`) и от Reader
  (`probe-depot-users-reader-no-bind`) — список пользователей.
- Неверный хеш пароля (`probe-history-wrong-password`) — `call_exception`, `auth-failed`, код 4.

Вывод: привязка не нужна ни истории, ни списку пользователей; `authenticate` перед ними не требуется.
Клиент расширения `bind` не вызывает ([repository-crs.md](../../repository-crs.md)).

## Фильтры истории (2026-09-30, iljyxa/vscode-1c-repository-tools#39)

Пробы уровня тел на `crserver` 8.5.1.1529: `example/crs/8.5.1/tcp/probe-history-*` (кроме четырёх проб
привязки выше), сводка — `history-probes-summary.json`, скрипт — `capture-history-probes.mjs` исходного проекта.
Хранилище — версии 1–6 из раздела «Как снято» (общий модуль `history-repository.mjs` исходного проекта) и версия
7 от Admin: изменено свойство «Версия» конфигурации на `1.0.0.2` (помещён только корень). Запрос — снятый
кадр `devDepotReport` Конфигуратора без `crs:bind`, в нём подстановкой меняются только поля фильтра; контроль —
`probe-history-filter-none` (все 7 версий, 16 изменённых объектов). Списки uuid — элементы `crs:value` с
атрибутом `value`, как `objRefs` в `devObjectsStatistic`: `<crs:userIDs><crs:value value="<uuid>"/></crs:userIDs>`.

### `mask` — битовая маска включённых фильтров

| Бит | Включает | Без бита |
|---|---|---|
| `1` | диапазон: номера (`beginVerNum`/`endVerNum`) и даты (`beginDate`/`endDate`) | номера и даты игнорируются: `probe-history-mask-0-range` (2–3) и `probe-history-date-future-mask-0` (2100 г.) — все версии |
| `2` | авторы `userIDs` | список игнорируется: `probe-history-user-petrov-mask-1` — все версии |
| `4` | объекты `objRefs` (с `recursive`) | список игнорируется: `probe-history-object-catalog-mask-1` — все версии |

Конфигуратор всегда шлёт `1` (диапазон «без ограничения» задаётся `-1` и `0001-01-01T00:00:00`), crs-api — `0`;
без фильтров ответы одинаковы (`probe-history-mask-0`). Бит включён при пустом списке — пустой ответ
(`probe-history-mask-2-no-users`, `probe-history-mask-4-no-objects`), неизвестный uuid — тоже
(`probe-history-user-unknown`, `probe-history-object-unknown`). Биты сочетаются по «и»: `mask=6`, справочник и
Petrov — версии 2 и 3 (`probe-history-object-catalog-user-petrov`); `mask=5`, справочник и `beginVerNum=2` —
2, 3, 6 (`probe-history-object-catalog-range`). `labels`/`onlyLabels` и `configVersion` от маски не зависят:
`onlyLabels` со справочником — только версия 2 (`probe-history-object-catalog-only-labels`).

### Авторы — `userIDs` (бит 2)

Petrov — версии 2 и 3 и только их изменённые объекты (`probe-history-user-petrov`); Admin и Petrov — все
версии (`probe-history-user-both`). Несколько uuid — «или».

### Объекты — `objRefs` и `recursive` (бит 4)

| Проба | Объекты | Версии в ответе |
|---|---|---|
| `probe-history-object-catalog` | `Справочник.Контрагенты` | 1, 2, 3, 6 |
| `probe-history-object-catalog-recursive` | он же, `recursive=true` | 1, 2, 3, 6, **1, 1** |
| `probe-history-object-form` | его форма | 1 |
| `probe-history-object-root` | корень конфигурации | 1, 7 |
| `probe-history-object-root-recursive` | корень, `recursive=true` | все, как без фильтра |
| `probe-history-object-two` | справочник и общий модуль | **1, 3, 4, 5, 1, 2, 3, 6** |

- В `depotVersions` остаются только отобранные объекты: у версии 3 со справочником нет общего модуля, хотя в
  версии изменены оба. Для истории объекта это ровно нужный состав.
- `recursive=true` добавляет потомков по `parentID`: форма и макет справочника (версия 1); у корня — все
  объекты конфигурации.
- **Версии в `objectVersions` повторяются**: ответ сгруппирован по объектам, и версия, в которой изменено
  несколько отобранных объектов, приходит у каждого — тот же `versionID`, та же метка. Порядок групп не
  совпадает с порядком `objRefs` (в `object-two` общий модуль идёт первым). Клиенту, передающему больше одного
  объекта или `recursive=true`, нужно схлопывать версии по `verNum`/`versionID`; `processOrder` в таком ответе
  считает повторы: `0` на каждый элемент `objectVersions`, `1` на каждый объект (8 + 8 в `object-two`).

### Версия конфигурации — `configVersion`

Точное совпадение с `info/code`: `1.0.0.1` — версии 1–6, `1.0.0.2` — только 7, `9.9.9.9` — пусто
(`probe-history-config-version-*`); от `mask` не зависит (`probe-history-config-version-2-mask-0`).

### Границы дат (бит 1)

По дате версии 3 (`D`, секунды; стенд в UTC): `beginDate=endDate=D` — только 3 (`probe-history-date-exact`),
`beginDate=D+1с` — 4–7 (`date-begin-after`), `endDate=D` — 1–3 (`date-end-at`), `endDate=D−1с` — 1–2
(`date-end-before`). Обе границы включительные, с точностью до секунды; одна граница без другой работает
(«нет» = `0001-01-01T00:00:00`).

### `DevDepot_devDepotVersions`

На 8.5.1 метод есть и принимает тот же фильтр, что `devDepotReport` (`probe-history-devdepotversions`). Ответ —
`call_return` с `crs:versions`: элементы `value/{first=<verNum>, second/{info, label?}}`, `info` и `label` — те же
поля, что в `objectVersions`. Нет `crs:data`, `depotVersions` и `processOrder`: только версии, без состава
изменений (4 КБ против 19 КБ у `devDepotReport` на 7 версиях). Фильтры действуют так же
(`-user-petrov` — 2 и 3), но **версии не повторяются**: `-object-two` — 1–6 по разу. Фильтр в записи crs-api
(`mask 0`, `<crs:beginVerNum>4294967295</crs:beginVerNum>` текстом) — `call_exception` «Ошибка преобразования
данных XML» (`probe-history-devdepotversions-crs-api`): числа только атрибутом `value`, как у Конфигуратора.

### Для клиента

1. История объекта запрашивается сервером: `mask=4`, `objRefs=[uuid]`, `recursive=true` — объект и его
   потомки, в `depotVersions` только они. Заменило клиентский отбор по `parentID` в исходном проекте (#89);
   повторяющиеся версии схлопываются по `verNum` в `CrsHistory.ts` ([repository-crs.md](../../repository-crs.md)).
2. `devDepotVersions` — лёгкий список версий без состава изменений и без `crs:data`: пагинация по диапазону
   номеров и список версий объекта без повторов (в исходном проекте #83; сценарий загрузки по страницам — этап 2
   в onecdev, iljyxa/onecdev#117; раздел «Постраничная загрузка» ниже).
3. Фильтр по автору и версии конфигурации — сервером (`mask` с битом 2; `configVersion` — точное совпадение).

### Постраничная загрузка (2026-10-01, iljyxa/vscode-1c-repository-tools#83)

Пробы — `probe-history-devdepotversions-object-{catalog-recursive,root-recursive,unknown}`,
`probe-history-page-{1-7,5-7,2-4,1-1}` (`mask=1`), `probe-history-page-object-catalog-recursive-{3-6,1-2,1-6}`,
`probe-history-page-object-root-recursive-{5-7,1-7}` (`mask=5`); скрипт — `capture-history-probes.mjs` исходного
проекта. Оба транспорта пересняты целиком, поэтому uuid и даты прежних проб изменились.

- **Отчёт с диапазоном и объектами** (`mask=5`) возвращает только версии диапазона `beginVerNum..endVerNum`
  (включительно) и только отобранные объекты.
- **Номера версий объекта разрежены**: у справочника с подчинёнными это 1, 2, 3, 6. Страница «две версии» —
  не `N..N-1`, а границы из списка: 3..6. Поэтому клиент сначала берёт список `devDepotVersions` по тому же
  фильтру, а границы страниц — реальные номера из него.
- **Пустой список** — `call_return` с пустым `<crs:versions/>` (неизвестный объект,
  `probe-history-devdepotversions-object-unknown`); лишних вызовов клиент не делает.
- **Порядок `crs:versions` — по возрастанию номера**, в том числе при нескольких объектах; клиент всё равно
  сортирует и убирает повторы сам, порядок сервера на него не полагается.
- **Повторы в странице с объектами сохраняются**: в странице справочника 1–2 версия 1 приходит трижды (у
  справочника и двух его подчинённых); схлопывает их разбор в `CrsHistory.ts`, в
  списке `devDepotVersions` повторов нет.

### Http (2026-09-30, iljyxa/vscode-1c-repository-tools#89; дополнено 2026-10-01, #83)

История объекта повторена через публикацию `.1ccr`: `node example/tools/crs/capture-history-probes.mjs
--transport=http` (список `HTTP_PROBES`: пробы истории объекта, `devdepotversions*` и все `page-*`),
каталоги `example/crs/8.5.1/http/probe-history-*`, сводка — `http/history-probes-summary.json`. Состав ответов тот же,
что по tcp: версии, `depotVersions` только отобранных объектов, повторы версий у каждого объекта, пустой ответ
для неизвестного uuid и пустой `<crs:versions/>`. Побайтно ответы tcp и http не равны: сборки хранилища
отдельные, uuid и даты разные. Фильтры по авторам, `configVersion` и датам по http не снимались.
