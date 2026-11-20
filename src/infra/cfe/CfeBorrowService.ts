import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { META_TYPES, type MetaKind, type MetaTypeDef, getMetaFolder } from '../../domain/MetaTypes';
import { buildBorrowedChildXml } from '../xml/BorrowedChildXml';
import { buildBorrowedFormExtXml } from '../xml/BorrowedFormXml';
import { ConfigurationXmlEditor } from '../xml/ConfigurationXmlEditor';
import { writeNewExportFile } from '../fs/NewExportFile';
import {
  MAIN_CHILD_OBJECTS_ENTRY_INDENT,
  ensureMainChildObjects,
  registerChildInMainChildObjects,
} from '../xml/MainChildObjectsEditor';
import {
  extractChildMetaElementXml,
  extractMainChildObjectsInnerXml,
  writeTextFilePreservingBomAndEol,
} from '../xml/XmlUtils';
import { resolveFormatRuleset } from '../xml/format/formatRegistry';

/** Свойства CommonModule, которые копируются из источника в заимствованный объект */
const COMMON_MODULE_PROPS = [
  'Global', 'ClientManagedApplication', 'Server',
  'ExternalConnection', 'ClientOrdinaryApplication', 'ServerCall',
];

/** Дочерние объекты, которые в XML должны быть полноценными блоками, а не текстовыми ссылками */
const STRUCTURED_CHILD_TAGS = new Set<string>([
  'Attribute', 'AddressingAttribute', 'Dimension', 'Resource',
  'EnumValue', 'TabularSection', 'Command',
]);

export interface BorrowObjectResult {
  /** true — объект уже существовал в расширении (обновление не выполнялось) */
  alreadyBorrowed: boolean;
  /** Список созданных/изменённых файлов */
  files: string[];
}

/**
 * Сервис заимствования объектов из конфигурации 1С в расширение.
 * Портирует логику cfe-borrow.py на TypeScript без зависимости от vscode.
 */
export class CfeBorrowService {
  private readonly configEditor = new ConfigurationXmlEditor();

  /**
   * Проверяет, заимствован ли уже объект в расширении.
   * Критерий — наличие XML-файла объекта в каталоге расширения.
   */
  isObjectBorrowed(extDir: string, typeName: string, objectName: string): boolean {
    const folder = this.getFolderName(typeName);
    if (!folder) {
      return false;
    }
    const objFile = path.join(extDir, folder, `${objectName}.xml`);
    return fs.existsSync(objFile);
  }

  /**
   * Заимствует объект метаданных из конфигурации в расширение.
   * Если объект уже заимствован — возвращает `alreadyBorrowed: true` без изменений.
   */
  borrowObject(cfDir: string, extDir: string, typeName: string, objectName: string): BorrowObjectResult {
    if (this.isObjectBorrowed(extDir, typeName, objectName)) {
      return { alreadyBorrowed: true, files: [] };
    }

    const folder = this.getFolderName(typeName);
    if (!folder) {
      throw new Error(`Неизвестный тип метаданных для заимствования: "${typeName}"`);
    }

    const sourceXmlPath = this.resolveSourceXml(cfDir, folder, objectName);
    if (!sourceXmlPath) {
      throw new Error(`Исходный XML объекта не найден: ${path.join(cfDir, folder, objectName)}`);
    }

    const sourceXml = fs.readFileSync(sourceXmlPath, 'utf-8');
    const sourceUuid = this.extractUuid(sourceXml);
    if (!sourceUuid) {
      throw new Error(`Не удалось извлечь UUID из исходного XML: ${sourceXmlPath}`);
    }

    const formatVersion = this.detectFormatVersion(extDir);
    const commonModuleProps = typeName === 'CommonModule'
      ? this.extractCommonModuleProps(sourceXml)
      : {};

    // `<ChildObjects>` — по исходному объекту, а не по `childTags`: у критерия отбора,
    // хранилища настроек, внешнего источника данных и сервиса интеграции дочерние только
    // формы/макеты/таблицы, но без пустого блока платформа не загружает расширение (#170).
    const withChildObjects = extractMainChildObjectsInnerXml(sourceXml) !== null;
    const borrowedXml = this.buildBorrowedObjectXml(
      typeName, objectName, sourceUuid, formatVersion, commonModuleProps, withChildObjects
    );

    const targetDir = path.join(extDir, folder);
    fs.mkdirSync(targetDir, { recursive: true });
    const targetFile = path.join(targetDir, `${objectName}.xml`);
    writeNewExportFile(targetFile, borrowedXml);

    const extConfigXmlPath = path.join(extDir, 'Configuration.xml');
    this.configEditor.addChildObject(extConfigXmlPath, `${typeName}.${objectName}`);

    return { alreadyBorrowed: false, files: [targetFile, extConfigXmlPath] };
  }

  /**
   * Заимствует форму объекта.
   * Родительский объект автоматически заимствуется, если ещё не был.
   */
  borrowForm(
    cfDir: string,
    extDir: string,
    typeName: string,
    objectName: string,
    formName: string
  ): BorrowObjectResult {
    this.assertSupportsChildObjects(typeName, `формы ${formName}`);
    const files: string[] = [];

    const parentResult = this.borrowObject(cfDir, extDir, typeName, objectName);
    if (!parentResult.alreadyBorrowed) {
      files.push(...parentResult.files);
    }

    const folder = this.getFolderName(typeName);
    if (!folder) {
      throw new Error(`Неизвестный тип метаданных: "${typeName}"`);
    }

    const formMetaDir = path.join(extDir, folder, objectName, 'Forms');
    const formMetaFile = path.join(formMetaDir, `${formName}.xml`);
    const objFile = path.join(extDir, folder, `${objectName}.xml`);

    if (fs.existsSync(formMetaFile)) {
      // Файлы формы есть, но запись в XML объекта могла не попасть: до issue #28 оболочки
      // обработок/отчётов/журналов создавались без <ChildObjects>, и регистрация молча пропускалась.
      if (this.registerChildInParentObject(objFile, 'Form', formName)) {
        if (!files.includes(objFile)) {
          files.push(objFile);
        }
        return { alreadyBorrowed: false, files };
      }
      return { alreadyBorrowed: true, files: [] };
    }

    const sourceFormXmlPath = this.resolveSourceFormXml(cfDir, folder, objectName, formName);
    if (!sourceFormXmlPath) {
      throw new Error(
        `Исходный XML формы не найден: ${path.join(cfDir, folder, objectName, 'Forms', formName)}`
      );
    }
    const sourceFormXml = fs.readFileSync(sourceFormXmlPath, 'utf-8');
    const sourceFormUuid = this.extractUuid(sourceFormXml);
    if (!sourceFormUuid) {
      throw new Error(`Не удалось извлечь UUID из XML формы: ${sourceFormXmlPath}`);
    }

    const formatVersion = this.detectFormatVersion(extDir);
    fs.mkdirSync(formMetaDir, { recursive: true });

    const sourceFormExtXmlPath = path.join(
      path.dirname(sourceFormXmlPath), formName, 'Ext', 'Form.xml'
    );
    const hasFormExt = fs.existsSync(sourceFormExtXmlPath);

    const formMetaXml = this.buildBorrowedFormMetaXml(formName, sourceFormUuid, formatVersion, hasFormExt);
    writeNewExportFile(formMetaFile, formMetaXml);
    files.push(formMetaFile);

    if (hasFormExt) {
      const sourceFormExtXml = fs.readFileSync(sourceFormExtXmlPath, 'utf-8');
      const borrowedFormExtXml = buildBorrowedFormExtXml(sourceFormExtXml);
      const formExtDir = path.join(formMetaDir, formName, 'Ext');
      const formExtFile = path.join(formExtDir, 'Form.xml');
      writeNewExportFile(formExtFile, borrowedFormExtXml);
      files.push(formExtFile);
      // Пустой Ext/Form/Module.bsl не создаётся: платформа его не выгружает, и после цикла
      // «загрузка → выгрузка» файл пропадал (#167). Модуль появляется с первым перехватчиком
      // (CfePatchMethodService создаёт его сам).
    }

    // XML родителя уже в files, если родитель заимствован этим же вызовом.
    if (this.registerChildInParentObject(objFile, 'Form', formName) && !files.includes(objFile)) {
      files.push(objFile);
    }

    return { alreadyBorrowed: false, files };
  }

  /**
   * Заимствует дочерний элемент (реквизит, ТЧ, измерение, ...) из конфигурации в расширение.
   * Автоматически заимствует родительский объект, если он ещё не заимствован.
   * Добавляет запись `<ChildTag>childName</ChildTag>` в ChildObjects родительского XML.
   * Для колонки ТЧ передавайте childTag='TabularSection' и имя самой ТЧ.
   */
  borrowChild(
    cfDir: string,
    extDir: string,
    typeName: string,
    objectName: string,
    childTag: string,
    childName: string
  ): BorrowObjectResult {
    this.assertSupportsChildObjects(typeName, `${childTag}.${childName}`);
    // Контейнер со своими вложенными элементами (URL-шаблон с методами) нельзя зарегистрировать
    // текстовой ссылкой — платформа такой XML не примет, а полного блока для него пока не строим.
    if (!STRUCTURED_CHILD_TAGS.has(childTag) && this.hasChildObjects(childTag)) {
      throw new Error(`Заимствование ${childTag}.${childName} не поддерживается: элемент содержит вложенные объекты`);
    }
    const files: string[] = [];

    const parentResult = this.borrowObject(cfDir, extDir, typeName, objectName);
    if (!parentResult.alreadyBorrowed) {
      files.push(...parentResult.files);
    }

    const folder = this.getFolderName(typeName);
    if (!folder) {
      throw new Error(`Неизвестный тип метаданных: "${typeName}"`);
    }

    const objFile = path.join(extDir, folder, `${objectName}.xml`);
    const borrowedChildXml = this.buildBorrowedChildXml(
      cfDir, folder, objectName, childTag, childName
    );
    const childAdded = this.registerChildInParentObject(objFile, childTag, childName, borrowedChildXml);

    if (!childAdded && parentResult.alreadyBorrowed) {
      return { alreadyBorrowed: true, files: [] };
    }

    if (childAdded && !files.includes(objFile)) {
      files.push(objFile);
    }

    return { alreadyBorrowed: false, files };
  }

  /** Папка типа метаданных в структуре выгрузки или undefined если тип неизвестен */
  getFolderName(typeName: string): string | undefined {
    if (!this.findMetaType(typeName)) {
      return undefined;
    }
    return getMetaFolder(typeName as MetaKind) ?? undefined;
  }

  /**
   * Есть ли у объекта этого типа `<ChildObjects>` в XML. Источник — `META_TYPES[kind].childTags`,
   * а не собственный список: параллельный реестр уже однажды отстал от него (issue #28).
   */
  private hasChildObjects(typeName: string): boolean {
    return (this.findMetaType(typeName)?.childTags?.length ?? 0) > 0;
  }

  private findMetaType(typeName: string): MetaTypeDef | undefined {
    // hasOwnProperty, а не `in`: иначе 'constructor'/'toString' сошли бы за тип метаданных.
    return Object.prototype.hasOwnProperty.call(META_TYPES, typeName)
      ? META_TYPES[typeName as MetaKind]
      : undefined;
  }

  /**
   * Отбивает заимствование дочернего элемента у типа без `<ChildObjects>` ДО записи файлов:
   * иначе оболочка и файлы формы создавались бы, а регистрация в XML объекта молча не выполнялась.
   * Неизвестный тип пропускается — его отбивает `borrowObject` своим сообщением.
   */
  private assertSupportsChildObjects(typeName: string, childLabel: string): void {
    if (this.findMetaType(typeName) && !this.hasChildObjects(typeName)) {
      throw new Error(
        `Тип "${typeName}" не содержит дочерних объектов: заимствование ${childLabel} невозможно`
      );
    }
  }

  /**
   * Добавляет `<childTag>childName</childTag>` (или готовый блок `childXml`) в главный `<ChildObjects>` XML-файла объекта.
   * Возвращает true, если запись была добавлена, false — если она уже присутствует.
   * Оболочке без `<ChildObjects>` (заимствована до issue #28) блок дописывается; если дописать
   * некуда — исключение, а не молчаливый успех.
   */
  private registerChildInParentObject(
    objFile: string,
    childTag: string,
    childName: string,
    childXml?: string
  ): boolean {
    const original = fs.readFileSync(objFile, 'utf-8');
    const withChildObjects = ensureMainChildObjects(original);
    if (withChildObjects === undefined) {
      throw new Error(
        `Не удалось зарегистрировать ${childTag}.${childName}: в XML объекта нет блока <Properties> (${objFile})`
      );
    }

    const next = registerChildInMainChildObjects(withChildObjects, childTag, childName, childXml);
    if (next === undefined) {
      return false;
    }

    writeTextFilePreservingBomAndEol(objFile, original, next);
    return true;
  }

  private buildBorrowedChildXml(
    cfDir: string,
    folder: string,
    objectName: string,
    childTag: string,
    childName: string
  ): string | undefined {
    if (!STRUCTURED_CHILD_TAGS.has(childTag)) {
      return undefined;
    }

    const sourceXmlPath = this.resolveSourceXml(cfDir, folder, objectName);
    if (!sourceXmlPath) {
      throw new Error(`Исходный XML объекта не найден: ${path.join(cfDir, folder, objectName)}`);
    }

    const sourceXml = fs.readFileSync(sourceXmlPath, 'utf-8');
    const sourceChildXml = extractChildMetaElementXml(sourceXml, childTag, childName);
    if (!sourceChildXml) {
      throw new Error(`Дочерний объект не найден в исходном XML: ${childTag}.${childName}`);
    }

    return buildBorrowedChildXml(sourceChildXml, childTag, MAIN_CHILD_OBJECTS_ENTRY_INDENT, () => this.newGuid());
  }

  private resolveSourceXml(cfDir: string, folder: string, objectName: string): string | null {
    const deepPath = path.join(cfDir, folder, objectName, `${objectName}.xml`);
    if (fs.existsSync(deepPath)) {
      return deepPath;
    }
    const flatPath = path.join(cfDir, folder, `${objectName}.xml`);
    if (fs.existsSync(flatPath)) {
      return flatPath;
    }
    return null;
  }

  private resolveSourceFormXml(
    cfDir: string, folder: string, objectName: string, formName: string
  ): string | null {
    const formMetaPath = path.join(cfDir, folder, objectName, 'Forms', `${formName}.xml`);
    if (fs.existsSync(formMetaPath)) {
      return formMetaPath;
    }
    return null;
  }

  private extractUuid(xml: string): string | null {
    const m = / uuid="([^"]+)"/.exec(xml);
    return m?.[1] ?? null;
  }

  private detectFormatVersion(extDir: string): string {
    const configXmlPath = path.join(extDir, 'Configuration.xml');
    if (!fs.existsSync(configXmlPath)) {
      return '2.17';
    }
    const head = fs.readFileSync(configXmlPath, 'utf-8').slice(0, 2000);
    const m = /<MetaDataObject[^>]+version="([\d.]+)"/.exec(head);
    return m?.[1] ?? '2.17';
  }

  private extractCommonModuleProps(sourceXml: string): Record<string, string> {
    const props: Record<string, string> = {};
    for (const propName of COMMON_MODULE_PROPS) {
      const m = new RegExp(`<${propName}>(true|false)<\\/${propName}>`).exec(sourceXml);
      if (m) {
        props[propName] = m[1];
      }
    }
    return props;
  }

  private buildInternalInfo(typeName: string, objectName: string, formatVersion: string): string {
    // Набор типов — из ruleset формата, как у объекта основной конфигурации: заимствованный
    // объект платформа выгружает с тем же составом, а без любого из них отбивает загрузку
    // расширения («отсутствует один или более типов объекта», #170).
    const types = resolveFormatRuleset(formatVersion).generatedTypes[typeName as MetaKind] ?? [];
    if (types.length === 0) {
      return '\t\t<InternalInfo/>';
    }

    const lines: string[] = ['\t\t<InternalInfo>'];

    if (typeName === 'ExchangePlan') {
      lines.push(`\t\t\t<xr:ThisNode>${this.newGuid()}</xr:ThisNode>`);
    }

    for (const gt of types) {
      const fullName = `${gt.prefix}.${objectName}`;
      lines.push(`\t\t\t<xr:GeneratedType name="${fullName}" category="${gt.category}">`);
      lines.push(`\t\t\t\t<xr:TypeId>${this.newGuid()}</xr:TypeId>`);
      lines.push(`\t\t\t\t<xr:ValueId>${this.newGuid()}</xr:ValueId>`);
      lines.push('\t\t\t</xr:GeneratedType>');
    }

    lines.push('\t\t</InternalInfo>');
    return lines.join('\n');
  }

  private buildBorrowedObjectXml(
    typeName: string,
    objectName: string,
    sourceUuid: string,
    formatVersion: string,
    commonModuleProps: Record<string, string>,
    withChildObjects: boolean
  ): string {
    const newUuid = this.newGuid();
    const internalInfo = this.buildInternalInfo(typeName, objectName, formatVersion);

    const lines: string[] = [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<MetaDataObject ${resolveFormatRuleset(formatVersion).metaDataObjectXmlns} version="${formatVersion}">`,
      `\t<${typeName} uuid="${newUuid}">`,
      internalInfo,
      `\t\t<Properties>`,
      `\t\t\t<ObjectBelonging>Adopted</ObjectBelonging>`,
      `\t\t\t<Name>${objectName}</Name>`,
      `\t\t\t<Comment/>`,
      `\t\t\t<ExtendedConfigurationObject>${sourceUuid}</ExtendedConfigurationObject>`,
    ];

    if (typeName === 'CommonModule') {
      for (const propName of COMMON_MODULE_PROPS) {
        const val = commonModuleProps[propName] ?? 'false';
        lines.push(`\t\t\t<${propName}>${val}</${propName}>`);
      }
    }

    // Пустые «Движения» платформа пишет у заимствованного документа сама, даже когда у
    // исходного они заполнены (выгрузка 8.3.27 и 8.5.1); без тега цикл «загрузка → выгрузка»
    // даёт diff (#170).
    if (typeName === 'Document') {
      lines.push(`\t\t\t<RegisterRecords/>`);
    }

    lines.push(`\t\t</Properties>`);

    if (withChildObjects) {
      lines.push(`\t\t<ChildObjects/>`);
    }

    lines.push(`\t</${typeName}>`);
    lines.push(`</MetaDataObject>`);

    return lines.join('\n');
  }

  private buildBorrowedFormMetaXml(
    formName: string,
    sourceUuid: string,
    formatVersion: string,
    extendsForm: boolean
  ): string {
    const newUuid = this.newGuid();
    // Раз у формы будет свой Ext/Form.xml, свойство «Форма» расширено: платформа пишет его
    // состояние в InternalInfo (выгрузка 8.3.27 и 8.5.1). Без блока загрузка проходит, но
    // каждый цикл «загрузка → выгрузка» даёт diff дескриптора (#161).
    const internalInfo = extendsForm
      ? [
        `\t\t<InternalInfo>`,
        `\t\t\t<xr:PropertyState>`,
        `\t\t\t\t<xr:Property>Form</xr:Property>`,
        `\t\t\t\t<xr:State>Extended</xr:State>`,
        `\t\t\t</xr:PropertyState>`,
        `\t\t</InternalInfo>`,
      ]
      : [`\t\t<InternalInfo/>`];
    // `includeFormUseInInterfaceCompatibilityMode` здесь не применяется: у заимствованной
    // формы платформа не пишет `<UseInInterfaceCompatibilityMode>` ни в 2.20, ни в 2.21
    // (выгрузка 8.3.27 и 8.5.1 расширения с заимствованной формой, #141).
    return [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<MetaDataObject ${resolveFormatRuleset(formatVersion).metaDataObjectXmlns} version="${formatVersion}">`,
      `\t<Form uuid="${newUuid}">`,
      ...internalInfo,
      `\t\t<Properties>`,
      `\t\t\t<ObjectBelonging>Adopted</ObjectBelonging>`,
      `\t\t\t<Name>${formName}</Name>`,
      `\t\t\t<Comment/>`,
      `\t\t\t<ExtendedConfigurationObject>${sourceUuid}</ExtendedConfigurationObject>`,
      `\t\t\t<FormType>Managed</FormType>`,
      `\t\t</Properties>`,
      `\t</Form>`,
      `</MetaDataObject>`,
    ].join('\n');
  }

  private newGuid(): string {
    return crypto.randomUUID();
  }
}

