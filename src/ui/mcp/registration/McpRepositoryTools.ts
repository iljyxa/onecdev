/**
 * MCP-инструменты хранилища конфигурации. Операции захвата и получения
 * регистрируются рядом с историей, в McpRepositoryOperations.
 *
 * Домен «repository»: repository_history. История идёт тем же кодом, что у панели «История хранилища»
 * (`resolveRepositoryHistoryTarget` → `RepositoryHistoryService.query`), но без состояния панели.
 * Только чтение: XML выгрузки, база и Конфигуратор не трогаются, поэтому нет ни проверок блокировки,
 * ни аренды ConfigurationOperationGuard, ни post-mutation пути — изменённых файлов не бывает.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import type { RepositoryHistory } from '../../../infra/repository/history/RepositoryHistoryModel';
import type { RepositoryHistoryQueryResult, RepositoryHistoryScope } from '../../../infra/repository/history/RepositoryHistoryService';
import {
  resolveRepositoryHistoryTarget,
  type RepositoryHistoryTargetResolution,
} from '../../../infra/repository/history/RepositoryHistoryTarget';
import type { McpRegistrationDeps } from './McpRegistrationDeps';
import { registerRepositoryOperations } from './McpRepositoryOperations';

/** Меньше страницы панели: ответ инструмента целиком уходит в контекст агента. */
const DEFAULT_LIMIT = 20;
/** Версия с тысячами изменённых объектов (первое помещение) не должна раздувать ответ. */
const DEFAULT_MAX_CHANGES_PER_VERSION = 100;

export function registerRepositoryTools(server: McpServer, deps: McpRegistrationDeps): void {
  const { paths, services, gate } = deps;

  server.registerTool(
    'onecdev_repository_history',
    {
      title: 'История хранилища',
      description: [
        'Версии хранилища конфигурации по протоколу сервера: номер, автор, дата, комментарий, метка и изменённые объекты.',
        'Принимает канонический путь: Конфигурация или Расширение — вся история; объект (Справочники.Контрагенты),',
        'его форма или макет (Справочники.X.Форма.Y, Справочники.X.Макет.Y), ОбщиеФормы.X, Подсистема.X.Y — история этого объекта.',
        'Более ранние версии — повторный вызов с beforeVersion = nextBeforeVersion. Только чтение.',
      ].join(' '),
      inputSchema: z.object({
        path: z.string(),
        configuration: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
        beforeVersion: z.number().int().min(2).optional(),
        maxChangesPerVersion: z.number().int().min(0).max(1000).optional(),
      }),
    },
    ({ path: canonical, configuration, limit, beforeVersion, maxChangesPerVersion }) => gate.wrapAsync(async () => {
      const node = paths.resolveNode(canonical, configuration);
      // label узла дерева может быть TreeItemLabel; хранилищу нужно имя элемента строкой.
      const ref = { nodeKind: node.nodeKind, label: node.textLabel, xmlPath: node.xmlPath, metaContext: node.metaContext };
      const scope = scopeOf(resolveRepositoryHistoryTarget(services.repositoryService, ref), canonical);
      const result = await services.repositoryHistoryService.query({
        target: scope.target,
        objectId: scope.filter?.objectId,
        pageSize: limit ?? DEFAULT_LIMIT,
        beforeVersion,
      });
      return toToolOutput(scope, historyOf(result), maxChangesPerVersion ?? DEFAULT_MAX_CHANGES_PER_VERSION);
    }),
  );
  registerRepositoryOperations(server, deps);
}

function scopeOf(resolution: RepositoryHistoryTargetResolution, canonical: string): RepositoryHistoryScope {
  switch (resolution.kind) {
    case 'root':
    case 'object':
      return resolution.scope;
    case 'no-target':
      throw new Error(`Не удалось определить конфигурацию для пути "${canonical}".`);
    case 'unsupported-node': {
      // Неподдерживаемый узел — всегда дочерний элемент объекта, а объект — первые два сегмента канона.
      const owner = canonical.split('.').slice(0, 2).join('.');
      throw new Error(
        `История в хранилище хранится по объекту-владельцу: укажите путь объекта (${owner}), его формы (${owner}.Форма.Имя) или макета (${owner}.Макет.Имя).`,
      );
    }
    case 'no-uuid':
      throw new Error(`Не удалось прочитать идентификатор объекта ${resolution.fullName} из его XML в выгрузке.`);
  }
}

function historyOf(result: RepositoryHistoryQueryResult): RepositoryHistory {
  switch (result.kind) {
    case 'ok':
      return result.history;
    case 'disconnected':
      throw new Error('Хранилище конфигурации не подключено. Выполните «Подключить к хранилищу».');
    case 'file-repository':
      throw new Error('История файлового хранилища по протоколу сервера недоступна. Постройте отчёт по хранилищу через Конфигуратор («Построить отчет по хранилищу»).');
    case 'failed':
      // Текст отказа уже переведён без тела запроса и хеша пароля (toRepositoryHistoryFailure).
      throw new Error(result.failure.message);
  }
}

/** Проекция модели для агента: без uuid версий и авторов, без версии платформы. */
function toToolOutput(scope: RepositoryHistoryScope, history: RepositoryHistory, maxChanges: number): unknown {
  const versions = history.versions.map((v) => ({
    number: v.verNum,
    author: v.author,
    date: v.date,
    comment: v.comment,
    ...(v.label === undefined ? {} : { label: { name: v.label.name, comment: v.label.comment, author: v.label.author, date: v.label.date } }),
    configVersion: v.configVersion,
    changes: v.changes.slice(0, maxChanges).map((c) => ({ objectId: c.objectId, title: c.title, kind: c.kind })),
    changesTruncated: v.changes.length > maxChanges,
  }));
  const pending = history.pending;
  return {
    target: scope.target.displayName,
    ...(scope.filter === undefined ? {} : { object: { objectId: scope.filter.objectId, title: scope.filter.title } }),
    total: versions.length + pending.length,
    versions,
    // pending — более ранние номера по убыванию: следующая страница — всё, что младше старшего из них + 1.
    ...(pending.length === 0 ? {} : { nextBeforeVersion: pending[0] + 1 }),
  };
}
