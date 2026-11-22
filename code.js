figma.showUI(__html__, { width: 480, height: 760, themeColors: true });

let latestRequestId;
let latestPhotoRequestId;
const templatePrefix = 'smartMockup.template.v1/';
let templateQueue = Promise.resolve();
const isMockup = node => node && node.getPluginData('smartMockupOutput') === '1';
const isSource = node => node && node.type === 'FRAME' && !isMockup(node);

function findMockup(node) {
  for (let current = node; current && current.type !== 'PAGE' && current.type !== 'DOCUMENT'; current = current.parent) {
    if (isMockup(current)) return current;
  }
  return null;
}

function photoFills(node) {
  if (!node || typeof node.exportAsync !== 'function' || !Array.isArray(node.fills) || findMockup(node)) return [];
  return node.fills.filter(paint => paint.type === 'IMAGE' && paint.imageHash && paint.visible !== false && paint.opacity !== 0);
}

function reportSelection() {
  const selection = figma.currentPage.selection;
  const node = selection[0];
  const mockup = findMockup(node);
  const canUseAsPhoto = photoFills(node).length > 0;
  figma.ui.postMessage({
    type: 'selection-changed',
    nodeId: !mockup && !canUseAsPhoto && isSource(node) ? node.id : null,
    photoId: canUseAsPhoto && selection.length === 1 ? node.id : null,
    mockupId: mockup?.id ?? null,
    sourceNodeId: mockup?.getPluginData('sourceNodeId') ?? null,
  });
}

async function exportFrame(msg) {
  latestRequestId = msg.requestId;
  try {
    const node = msg.nodeId ? await figma.getNodeByIdAsync(msg.nodeId) : figma.currentPage.selection[0];
    if (!isSource(node)) throw Error('Выделите фрейм сайта в Figma.');
    const { id, name, width, height } = node;
    const requested = Math.max(1, Math.min(3, Number(msg.scale) || 2));
    const scale = Math.min(requested, 12000 / Math.max(width, height));
    const bytes = await node.exportAsync({
      format: 'PNG',
      useAbsoluteBounds: true,
      colorProfile: 'SRGB',
      constraint: { type: 'SCALE', value: scale },
    });
    if (msg.requestId !== latestRequestId) return;
    figma.ui.postMessage({ type: 'selection', requestId: msg.requestId, nodeId: id, name, width, height, requested, scale, bytes });
  } catch (error) {
    if (msg.requestId !== latestRequestId) return;
    figma.ui.postMessage({ type: 'selection-error', requestId: msg.requestId, message: error.message });
  }
}

async function exportPhoto(msg) {
  latestPhotoRequestId = msg.requestId;
  try {
    const node = await figma.getNodeByIdAsync(msg.nodeId);
    const fills = photoFills(node);
    if (!fills.length) throw Error('Выделите один слой с заливкой изображением в Figma.');
    const sizes = await Promise.all(fills.map(paint =>
      figma.getImageByHash(paint.imageHash)?.getSizeAsync().catch(() => null)));
    if (msg.requestId !== latestPhotoRequestId) return;
    const longest = Math.max(node.width, node.height, ...sizes.filter(Boolean).map(size => Math.max(size.width, size.height)));
    const bytes = await node.exportAsync({
      format: 'PNG',
      useAbsoluteBounds: true,
      colorProfile: 'SRGB',
      constraint: { type: node.width >= node.height ? 'WIDTH' : 'HEIGHT', value: Math.max(1, Math.min(4096, Math.round(longest))) },
    });
    if (msg.requestId === latestPhotoRequestId) {
      figma.ui.postMessage({ type: 'photo', requestId: msg.requestId, name: node.name, bytes });
    }
  } catch (error) {
    if (msg.requestId === latestPhotoRequestId) {
      figma.ui.postMessage({ type: 'photo-error', requestId: msg.requestId, message: error.message });
    }
  }
}

async function manageTemplate(msg) {
  const storage = figma.clientStorage;
  const requestId = msg.requestId;
  try {
    if (msg.type === 'template-list') {
      const keys = await storage.keysAsync();
      const names = keys.filter(key => key.startsWith(templatePrefix)).map(key => key.slice(templatePrefix.length));
      figma.ui.postMessage({ type: 'template-list', requestId, names });
      return;
    }
    const name = typeof msg.name === 'string' ? msg.name.trim().normalize('NFC') : '';
    if (!name || name.length > 80) throw Error('Введите название шаблона до 80 символов.');
    const key = templatePrefix + name;
    const existing = await storage.getAsync(key);
    if (msg.type === 'template-save' || msg.type === 'template-update') {
      if (existing && msg.type === 'template-save') throw Error('Шаблон с таким названием уже есть.');
      if (!existing && msg.type === 'template-update') throw Error('Шаблон больше не доступен. Откройте список заново.');
      if (!(msg.bytes instanceof Uint8Array) || msg.bytes.byteLength < 5) throw Error('Не удалось подготовить фото шаблона.');
      await storage.setAsync(key, msg.bytes);
      figma.ui.postMessage({ type: 'template-saved', requestId, name });
    } else if (msg.type === 'template-open') {
      if (!existing) throw Error('Шаблон больше не доступен. Откройте список заново.');
      figma.ui.postMessage({ type: 'template-photo', requestId, name, bytes: existing });
    } else if (msg.type === 'template-delete') {
      await storage.deleteAsync(key);
      figma.ui.postMessage({ type: 'template-deleted', requestId, name });
    }
  } catch (error) {
    const message = /quota|exceed|too large|storage.*limit/i.test(error.message)
      ? 'Хранилище шаблонов заполнено. Удалите неиспользуемый шаблон или выберите фото меньшего размера.'
      : error.message;
    figma.ui.postMessage({ type: 'template-error', requestId, message });
  }
}

async function writeMockup(msg) {
  let draft;
  try {
    const previous = msg.id ? await figma.getNodeByIdAsync(msg.id) : null;
    if (msg.id && !isMockup(previous)) throw Error('Исходный мокап не найден.');
    if (previous && previous.type !== 'FRAME' && previous.type !== 'RECTANGLE') throw Error('Неподдерживаемый слой мокапа.');
    const tiles = msg.tiles.map(tile => ({ ...tile, imageHash: figma.createImage(new Uint8Array(tile.bytes)).hash }));
    draft = figma.createFrame();
    draft.name = 'Frila Mockup Plugin';
    draft.layoutMode = 'NONE';
    draft.resize(msg.width, msg.height);
    draft.fills = [];
    draft.clipsContent = true;
    draft.setPluginData('smartMockupOutput', '1');
    draft.setPluginData('sourceNodeId', msg.sourceNodeId || '');
    for (const tile of tiles) {
      const rect = figma.createRectangle();
      draft.appendChild(rect);
      rect.name = 'Мокап';
      rect.resize(tile.width, tile.height);
      rect.x = tile.x;
      rect.y = tile.y;
      rect.fills = [{ type: 'IMAGE', imageHash: tile.imageHash, scaleMode: 'FILL' }];
      rect.constraints = { horizontal: 'SCALE', vertical: 'SCALE' };
      rect.locked = true;
    }
    let result = draft;
    if (previous && previous.type === 'FRAME') {
      const previousTiles = [...previous.children];
      previous.layoutMode = 'NONE';
      previous.clipsContent = true;
      previous.resizeWithoutConstraints(msg.width, msg.height);
      for (const [index, tile] of [...draft.children].entries()) {
        previous.appendChild(tile);
        tile.x = tiles[index].x;
        tile.y = tiles[index].y;
      }
      for (const tile of previousTiles) tile.remove();
      previous.setPluginData('sourceNodeId', msg.sourceNodeId || '');
      draft.remove();
      result = previous;
    } else if (previous && tiles.length === 1) {
      previous.resize(msg.width, msg.height);
      previous.fills = [{ type: 'IMAGE', imageHash: tiles[0].imageHash, scaleMode: 'FILL' }];
      previous.setPluginData('sourceNodeId', msg.sourceNodeId || '');
      draft.remove();
      result = previous;
    } else if (previous) {
      const container = previous.parent;
      const transform = previous.relativeTransform;
      const layoutPositioning = previous.layoutPositioning;
      container.insertChild(container.children.indexOf(previous), draft);
      draft.name = previous.name;
      if (container.layoutMode && container.layoutMode !== 'NONE') draft.layoutPositioning = layoutPositioning;
      draft.relativeTransform = transform;
      previous.remove();
    } else {
      const center = figma.viewport.center;
      draft.x = Math.round(center.x - msg.width / 2);
      draft.y = Math.round(center.y - msg.height / 2);
    }
    draft = null;
    figma.currentPage.selection = [result];
    figma.viewport.scrollAndZoomIntoView([result]);
    figma.ui.postMessage({ type: 'write-success', id: result.id, requestId: msg.requestId, update: Boolean(msg.id) });
  } catch (error) {
    if (draft && !draft.removed) draft.remove();
    figma.ui.postMessage({ type: 'write-error', requestId: msg.requestId, message: error.message });
  }
}

figma.ui.onmessage = msg => {
  if (msg.type === 'ready') reportSelection();
  if (msg.type === 'get-selection') return exportFrame(msg);
  if (msg.type === 'get-photo') return exportPhoto(msg);
  if (msg.type === 'write-mockup') return writeMockup(msg);
  if (['template-list', 'template-save', 'template-update', 'template-open', 'template-delete'].includes(msg.type)) {
    templateQueue = templateQueue.then(() => manageTemplate(msg));
    return templateQueue;
  }
};
figma.on('selectionchange', reportSelection);
