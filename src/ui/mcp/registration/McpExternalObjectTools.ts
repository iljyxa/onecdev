/**
 * MCP-инструменты внешних объектов (EPF/ERF), встроенной справки и БСП.
 *
 * Домен «externalObject»: add_help, create_epf, create_erf,
 * validate_external_object, epf_bsp_init, epf_bsp_add_command.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import { resolveObjectXmlByCanonical } from '../McpPathResolvers';
import { WORKSPACE_WRITE_PATH_HINT } from './McpMutationGate';
import type { McpRegistrationDeps } from './McpRegistrationDeps';

export function registerExternalObjectTools(server: McpServer, deps: McpRegistrationDeps): void {
  const { paths, services, gate } = deps;

  server.registerTool(
    'onecdev_add_help',
    {
      title: 'Добавить встроенную справку',
      description: [
        'Создаёт Ext/Help.xml и Ext/Help/<lang>.html для объекта и проставляет',
        'IncludeHelpInContents у форм при отсутствии.',
        'Принимает канонический путь объекта: Справочники.Контрагенты.',
      ].join(' '),
      inputSchema: z.object({
        path: z.string(),
        configuration: z.string().optional(),
        lang: z.string().optional(),
        title: z.string().optional(),
      }),
      annotations: {
        destructiveHint: true,
      },
    },
    ({ path: canonical, configuration, ...rest }) => gate.wrap(() => {
      gate.assertNodeEditable(paths.resolveNode(canonical, configuration));
      const objectPath = resolveObjectXmlByCanonical(paths, canonical, configuration);
      const result = services.externalObjectService.addHelp({ ...rest, objectPath });
      // Сервис бросает исключение при провале (перехват в wrap); дошли сюда — успех.
      gate.afterMutationIfSucceeded(result.changedFiles);
      return result;
    })
  );

  server.registerTool(
    'onecdev_create_epf',
    {
      title: 'Создать внешнюю обработку EPF',
      description: `Создаёт минимальные XML-исходники внешней обработки: корневой XML, каталог Ext и ObjectModule.bsl. ${WORKSPACE_WRITE_PATH_HINT}`,
      inputSchema: z.object({
        name: z.string(),
        synonym: z.string().optional(),
        outputDir: z.string(),
      }),
      annotations: {
        destructiveHint: true,
      },
    },
    (args) => gate.wrap(() => {
      const outputDir = gate.resolveWorkspaceWritePath(args.outputDir);
      const result = services.externalObjectService.createExternalDataProcessor({ ...args, outputDir });
      // Сервис бросает исключение при провале (перехват в wrap); дошли сюда — успех.
      gate.afterMutationIfSucceeded(result.changedFiles);
      return result;
    })
  );

  server.registerTool(
    'onecdev_create_erf',
    {
      title: 'Создать внешний отчёт ERF',
      description: `Создаёт минимальные XML-исходники внешнего отчёта; опционально добавляет основную СКД и привязку MainDataCompositionSchema. ${WORKSPACE_WRITE_PATH_HINT}`,
      inputSchema: z.object({
        name: z.string(),
        synonym: z.string().optional(),
        outputDir: z.string(),
        withSkd: z.boolean().optional(),
      }),
      annotations: {
        destructiveHint: true,
      },
    },
    (args) => gate.wrap(() => {
      const outputDir = gate.resolveWorkspaceWritePath(args.outputDir);
      const result = services.externalObjectService.createExternalReport({ ...args, outputDir });
      // Сервис бросает исключение при провале (перехват в wrap); дошли сюда — успех.
      gate.afterMutationIfSucceeded(result.changedFiles);
      return result;
    })
  );

  server.registerTool(
    'onecdev_validate_external_object',
    {
      title: 'Валидировать EPF/ERF XML',
      description: 'Проверяет структуру XML-исходников внешней обработки или отчёта: InternalInfo, Properties, ChildObjects, ссылки и файлы.',
      inputSchema: z.object({
        objectPath: z.string(),
        detailed: z.boolean().optional(),
        maxErrors: z.number().int().min(1).max(500).optional(),
      }),
    },
    (args) => gate.wrap(() => services.externalObjectService.validate(args))
  );

  server.registerTool(
    'onecdev_epf_bsp_init',
    {
      title: 'Добавить регистрацию БСП',
      description: `Добавляет функцию СведенияОВнешнейОбработке в ObjectModule.bsl внешней обработки/отчёта и базовый обработчик команды. ${WORKSPACE_WRITE_PATH_HINT}`,
      inputSchema: z.object({
        objectPath: z.string(),
        kind: z.string(),
        targets: z.array(z.string()).optional(),
      }),
      annotations: {
        destructiveHint: true,
      },
    },
    (args) => gate.wrap(() => {
      const objectPath = gate.resolveWorkspaceWritePath(args.objectPath);
      const result = services.externalObjectService.initBspRegistration({ ...args, objectPath });
      // Сервис бросает исключение при провале (перехват в wrap); дошли сюда — успех.
      gate.afterMutationIfSucceeded(result.changedFiles);
      return result;
    })
  );

  server.registerTool(
    'onecdev_epf_bsp_add_command',
    {
      title: 'Добавить команду БСП',
      description: `Добавляет команду в СведенияОВнешнейОбработке и создаёт/дополняет серверный, клиентский или печатный обработчик. ${WORKSPACE_WRITE_PATH_HINT}`,
      inputSchema: z.object({
        objectPath: z.string(),
        identifier: z.string(),
        commandType: z.string().optional(),
        presentation: z.string().optional(),
        formModulePath: z.string().optional(),
      }),
      annotations: {
        destructiveHint: true,
      },
    },
    (args) => gate.wrap(() => {
      const objectPath = gate.resolveWorkspaceWritePath(args.objectPath);
      const formModulePath = args.formModulePath === undefined ? undefined : gate.resolveWorkspaceWritePath(args.formModulePath);
      const result = services.externalObjectService.addBspCommand({ ...args, objectPath, formModulePath });
      // Сервис бросает исключение при провале (перехват в wrap); дошли сюда — успех.
      gate.afterMutationIfSucceeded(result.changedFiles);
      return result;
    })
  );
}
