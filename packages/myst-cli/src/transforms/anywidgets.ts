import { access, readdir } from 'node:fs/promises';
import type { GenericParent } from 'myst-common';
import { RuleId } from 'myst-common';
import { computeHash, hashAndCopyStaticFile, isUrl } from 'myst-cli-utils';
import { selectAll } from 'unist-util-select';
import path from 'node:path';
import type { ISession } from '../session/types.js';
import { addWarningForFile } from '../utils/addWarningForFile.js';
import { fetchRemoteAsset } from '../utils/fetchRemoteAsset.js';
import { getSourceFolder } from './links.js';
import { resolveOutputPath } from './images.js';
import type { AnyWidget } from 'myst-spec-ext';

/**
 * Marker used inside a widget's model to request that a value be treated as an asset.
 *
 * A widget's model is opaque JSON as far as MyST is concerned, so there is no way to
 * tell a file path from any other string. Rather than guess -- which would break the
 * moment a widget legitimately wants a string that looks like a path -- the document
 * says so explicitly:
 *
 *     {"source": {"$asset": "../data/object.zarr.zip"}}
 *
 * This transform copies the file and records where it landed under `$resolved`, leaving
 * the marker itself in place. Keeping it matters: a document's mdast is finalized more
 * than once per build (`processProject`, then again per site build), and a marker that
 * consumed itself on first pass would leave later passes with nothing to recognise --
 * and, worse, with a path they would try and fail to resolve a second time. Carrying the
 * answer alongside the question makes the transform idempotent.
 *
 * The renderer flattens the marker to a plain string, applying whatever baseurl or CDN
 * prefix it uses for `esm`, `css` and image URLs, so the widget itself sees only a URL
 * and needs to know nothing about any of this.
 */
const ASSET_KEY = '$asset';
const RESOLVED_KEY = '$resolved';

type AssetRef = { [ASSET_KEY]: string; [RESOLVED_KEY]?: string };

function isAssetRef(value: unknown): value is AssetRef {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return typeof (value as AssetRef)[ASSET_KEY] === 'string';
}

/**
 * Copy a single asset next to the built document and return the path to write into the AST.
 *
 * Remote URLs are fetched and cached by a hash of the URL; local paths are hashed and
 * copied. Returns `undefined` if the asset could not be resolved, having already logged
 * a warning against `filePath`.
 */
async function resolveAsset(
  session: ISession,
  filePath: string,
  assetPath: string,
  extension: string | undefined,
  writeFolder: string,
  resourceFolder: string,
  node: GenericParent,
  label: string,
): Promise<string | undefined> {
  const sourceFolder = getSourceFolder(assetPath, filePath, session.sourcePath());
  const localPath = path.join(sourceFolder, assetPath);

  // File name of the form `name.ext`, a single path component
  let fileName: string | undefined;
  if (isUrl(assetPath)) {
    const stem = computeHash(assetPath);

    // Check whether file with stem exists (but unknown extension)
    let existingName: string | undefined;
    try {
      const entries = await readdir(writeFolder);
      existingName = entries.find((f) => path.parse(f).name === stem);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw err;
    }
    if (existingName !== undefined) {
      session.log.debug(`Cached asset found for '${label}' (${assetPath})...`);
      fileName = existingName;
    } else {
      try {
        const { name } = await fetchRemoteAsset(session, assetPath, writeFolder, stem, {
          extension,
        });
        fileName = name;
        session.log.debug(
          `Fetching asset for '${label}' (${assetPath})...\n  -> saving to: ${fileName}`,
        );
      } catch (error) {
        session.log.debug(`\n\n${(error as Error).stack}\n\n`);
        addWarningForFile(
          session,
          filePath,
          `Error saving asset for '${label}' "${assetPath}": ${(error as Error).message}`,
          'error',
          { position: node.position },
          // TODO: add "asset downloads" rule?
        );
        return undefined;
      }
    }
  } else {
    try {
      await access(localPath);
    } catch {
      addWarningForFile(
        session,
        filePath,
        `Cannot find asset for '${label}' "${assetPath}" in ${sourceFolder}`,
        'error',
        { position: node.position },
        // TODO: add "asset exists" rule?
      );
      return undefined;
    }
    // non-url local image paths relative to the config.section.path
    if (path.resolve(path.dirname(localPath)) === path.resolve(writeFolder)) {
      // If file is already in write folder, don't hash/copy
      fileName = path.basename(localPath);
    } else {
      fileName = hashAndCopyStaticFile(session, localPath, writeFolder, (m: string) => {
        addWarningForFile(session, filePath, m, 'error', { ruleId: RuleId.imageCopied });
      });
    }
    if (!fileName) return undefined;
  }
  if (fileName === undefined) return undefined;
  return resolveOutputPath(fileName, writeFolder, resourceFolder);
}

/**
 * Walk a widget model, replacing `{"$asset": "path"}` markers with resolved asset URLs.
 *
 * Recurses through arrays and plain objects, so a marker nested inside e.g. a list of
 * variants is picked up just the same as a top-level one.
 */
async function resolveModelAssets(
  session: ISession,
  filePath: string,
  value: unknown,
  writeFolder: string,
  resourceFolder: string,
  node: GenericParent,
  keys: (string | number)[],
): Promise<unknown> {
  if (isAssetRef(value)) {
    // Already done on an earlier pass over this tree.
    if (typeof value[RESOLVED_KEY] === 'string') return value;
    const assetPath = value[ASSET_KEY];
    const resolved = await resolveAsset(
      session,
      filePath,
      assetPath,
      path.parse(assetPath).ext.replace(/^\./, '') || undefined,
      writeFolder,
      resourceFolder,
      node,
      `${ASSET_KEY} at model.${keys.join('.')}`,
    );
    // The warning is already logged; leave the marker unresolved so the renderer falls
    // back to the literal path rather than silently rendering nothing.
    if (resolved === undefined) return value;
    return { ...value, [RESOLVED_KEY]: resolved };
  }
  if (Array.isArray(value)) {
    return Promise.all(
      value.map((item, index) =>
        resolveModelAssets(session, filePath, item, writeFolder, resourceFolder, node, [
          ...keys,
          index,
        ]),
      ),
    );
  }
  if (typeof value === 'object' && value !== null) {
    const entries = await Promise.all(
      Object.entries(value).map(async ([key, item]) => {
        return [
          key,
          await resolveModelAssets(session, filePath, item, writeFolder, resourceFolder, node, [
            ...keys,
            key,
          ]),
        ] as const;
      }),
    );
    return Object.fromEntries(entries);
  }
  return value;
}

/**
 * Transform to resolve and stash static assets for anywidgets.
 * This is temporary — the problem of pulling out assets is generaliseable.
 *
 * Note — the `resourceFolder` is what we include in the AST. If we write to `/public/file.png`,
 * and the content server serves `/public` under `/`, then the `writeFolder` is `/public` and
 * the `resourceFolder` is `/`
 *
 * @param session session object
 * @param tree document AST
 * @param filePath path of source document
 * @param writeFolder path of folder to write to
 * @param resourceFolder alternative representation of writeFolder that is written to AST
 * @param opts.models whether to resolve `$asset` markers inside widget models. Builds that
 *   render the widget's `:placeholder:` instead of the widget itself (tex, typst, docx) have
 *   no use for the data and should not pay to copy it.
 */
export async function transformWidgetStaticAssetsToDisk(
  session: ISession,
  tree: GenericParent,
  filePath: string,
  writeFolder: string,
  resourceFolder: string,
  opts?: { models?: boolean },
) {
  for (const widgetNode of selectAll('anywidget', tree) as (AnyWidget & GenericParent)[]) {
    for (const [attr, ext] of [
      ['esm', 'mjs'],
      ['css', 'css'],
    ]) {
      const attrPath = (widgetNode as Record<string, unknown>)[attr] as string | undefined;
      if (attrPath === undefined) {
        continue;
      }
      const resolved = await resolveAsset(
        session,
        filePath,
        attrPath,
        ext,
        writeFolder,
        resourceFolder,
        widgetNode,
        attr,
      );
      // Update mdast with new file name
      if (resolved !== undefined) {
        widgetNode[attr] = resolved;
      }
    }
    if (opts?.models !== false && widgetNode.model) {
      widgetNode.model = (await resolveModelAssets(
        session,
        filePath,
        widgetNode.model,
        writeFolder,
        resourceFolder,
        widgetNode,
        [],
      )) as Record<string, unknown>;
    }
  }
}
