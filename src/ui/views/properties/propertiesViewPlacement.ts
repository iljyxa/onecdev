export const PROPERTIES_VIEW_ID = 'onecdevProperties';
export const NAVIGATOR_PROPERTIES_VIEW_ID = 'onecdevPropertiesInNavigator';
export const PROPERTIES_PLACEMENT_CONTEXT = 'onecdev.propertiesPlacement';

export function selectPropertiesViewId(version: string, appName: string): string {
  const [major, minor] = version.split('.').map(Number);
  const supportsSecondarySidebar = major > 1 || (major === 1 && minor >= 106);
  return supportsSecondarySidebar && !/cursor/i.test(appName)
    ? PROPERTIES_VIEW_ID
    : NAVIGATOR_PROPERTIES_VIEW_ID;
}
