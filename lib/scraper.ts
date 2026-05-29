import axios from "axios";
import * as cheerio from "cheerio";
import JSZip from "jszip";
import pLimit from "p-limit";
import robotsParser from "robots-parser";

export type AssetType =
  | "images"
  | "scripts"
  | "styles"
  | "media"
  | "documents"
  | "other";

export interface ScraperOptions {
  startUrl: string;
  maxPages: number;
  maxDepth: number;
  includeSubdomains: boolean;
  respectRobots: boolean;
  downloadAssets: boolean;
  assetLimitPerPage: number;
  maxAssetBytesPerFile: number;
  maxTotalAssetBytes: number;
  requestTimeoutMs: number;
}

interface QueueItem {
  url: string;
  depth: number;
}

interface LinkItem {
  href: string;
  text: string;
  rel: string;
  target: string;
  internal: boolean;
}

interface AssetItem {
  url: string;
  type: AssetType;
}

interface DownloadedAsset {
  sourceUrl: string;
  filePath: string;
  bytes: number;
  contentType: string;
}

interface PageResult {
  index: number;
  url: string;
  depth: number;
  statusCode: number;
  contentType: string;
  title: string;
  description: string;
  h1: string[];
  links: LinkItem[];
  assets: AssetItem[];
}

interface CrawlStats {
  startedAt: string;
  finishedAt: string;
  elapsedMs: number;
  pagesVisited: number;
  pagesRequested: number;
  filesWritten: number;
  assetsDownloaded: number;
  bytesDownloaded: number;
}

export interface ScrapeZipResult {
  fileName: string;
  contentType: string;
  data: Buffer;
}

const USER_AGENT =
  "UniversalWebScrapperBot/1.0 (+https://vercel.com; purpose=archival)";

const INTERNAL_EXTENSIONS = [
  ".html",
  ".htm",
  ".php",
  ".asp",
  ".aspx",
  ".jsp",
  ".jspx",
  ".cfm",
  ".cgi"
];

const DOCUMENT_EXTENSIONS = [
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".txt",
  ".csv",
  ".json",
  ".xml"
];

function normalizeUrl(rawUrl: string, baseUrl?: string): string | null {
  try {
    const url = baseUrl ? new URL(rawUrl, baseUrl) : new URL(rawUrl);
    if (!["http:", "https:"].includes(url.protocol)) {
      return null;
    }
    url.hash = "";
    if (url.protocol === "https:" && url.port === "443") {
      url.port = "";
    }
    if (url.protocol === "http:" && url.port === "80") {
      url.port = "";
    }
    const cleanedPath = url.pathname.replace(/\/{2,}/g, "/");
    url.pathname = cleanedPath.length > 1 ? cleanedPath.replace(/\/$/, "") : "/";
    return url.toString();
  } catch {
    return null;
  }
}

function toSafeSegment(input: string): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "root";
}

function makePageFolderName(index: number, pageUrl: string): string {
  const url = new URL(pageUrl);
  const pathSegment = toSafeSegment(url.pathname);
  return `${String(index).padStart(4, "0")}_${pathSegment}`;
}

function sameDomain(target: URL, origin: URL, includeSubdomains: boolean): boolean {
  if (target.hostname === origin.hostname) {
    return true;
  }
  if (!includeSubdomains) {
    return false;
  }
  return target.hostname.endsWith(`.${origin.hostname}`);
}

function looksLikeHtmlPath(pathname: string): boolean {
  const lower = pathname.toLowerCase();
  if (!lower.includes(".")) {
    return true;
  }
  return INTERNAL_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

function detectAssetType(pathname: string): AssetType {
  const p = pathname.toLowerCase();
  if (/\.(png|jpg|jpeg|gif|svg|webp|avif|ico|bmp|tiff)$/.test(p)) {
    return "images";
  }
  if (/\.(js|mjs|cjs|ts)$/.test(p)) {
    return "scripts";
  }
  if (/\.(css|scss|sass|less)$/.test(p)) {
    return "styles";
  }
  if (/\.(mp4|webm|ogg|mp3|wav|m4a|mov|avi)$/.test(p)) {
    return "media";
  }
  if (DOCUMENT_EXTENSIONS.some((extension) => p.endsWith(extension))) {
    return "documents";
  }
  return "other";
}

function stripText(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function buildAssetPath(pageFolder: string, assetUrl: string, index: number): string {
  const parsed = new URL(assetUrl);
  const extension = parsed.pathname.split(".").pop();
  const ext = extension && extension.length <= 5 ? extension : "bin";
  return `assets/${pageFolder}/${String(index).padStart(4, "0")}.${ext}`;
}

function buildInternalLinks(
  links: LinkItem[],
  origin: URL,
  includeSubdomains: boolean
): string[] {
  const unique = new Set<string>();
  for (const link of links) {
    const parsed = normalizeUrl(link.href);
    if (!parsed) {
      continue;
    }
    const url = new URL(parsed);
    if (sameDomain(url, origin, includeSubdomains) && looksLikeHtmlPath(url.pathname)) {
      unique.add(url.toString());
    }
  }
  return [...unique];
}

async function readRobots(origin: URL, timeout: number): Promise<string | null> {
  const robotsUrl = `${origin.origin}/robots.txt`;
  try {
    const response = await axios.get<string>(robotsUrl, {
      timeout,
      responseType: "text",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/plain,*/*;q=0.8"
      },
      validateStatus: (status) => status < 500
    });
    if (response.status >= 200 && response.status < 400) {
      return response.data;
    }
    return null;
  } catch {
    return null;
  }
}

function createPageRecord(
  index: number,
  url: string,
  depth: number,
  statusCode: number,
  contentType: string,
  html: string
): PageResult {
  const $ = cheerio.load(html);
  const title = stripText($("title").first().text());
  const description = stripText(
    $('meta[name="description"]').attr("content") ||
      $('meta[property="og:description"]').attr("content") ||
      ""
  );
  const h1 = $("h1")
    .toArray()
    .map((node) => stripText($(node).text()))
    .filter(Boolean);

  const links: LinkItem[] = $("a[href]")
    .toArray()
    .map((node) => {
      const href = stripText($(node).attr("href") || "");
      const absolute = normalizeUrl(href, url) || href;
      return {
        href: absolute,
        text: stripText($(node).text()),
        rel: stripText($(node).attr("rel") || ""),
        target: stripText($(node).attr("target") || ""),
        internal: false
      };
    })
    .filter((link) => link.href.length > 0);

  const assets: AssetItem[] = [];
  const assetCandidates: string[] = [];

  $("img[src],script[src],link[href],source[src],video[src],audio[src]")
    .toArray()
    .forEach((node) => {
      const attrib = $(node).attr("src") || $(node).attr("href");
      if (!attrib) {
        return;
      }
      const resolved = normalizeUrl(attrib, url);
      if (!resolved) {
        return;
      }
      assetCandidates.push(resolved);
    });

  const dedupedAssets = [...new Set(assetCandidates)];
  for (const assetUrl of dedupedAssets) {
    const type = detectAssetType(new URL(assetUrl).pathname);
    assets.push({ url: assetUrl, type });
  }

  return {
    index,
    url,
    depth,
    statusCode,
    contentType,
    title,
    description,
    h1,
    links,
    assets
  };
}

async function downloadAsset(
  zip: JSZip,
  pageFolder: string,
  asset: AssetItem,
  assetIndex: number,
  timeout: number,
  maxBytes: number
): Promise<DownloadedAsset | null> {
  try {
    const response = await axios.get<ArrayBuffer>(asset.url, {
      timeout,
      responseType: "arraybuffer",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "*/*"
      },
      maxContentLength: maxBytes,
      maxBodyLength: maxBytes,
      validateStatus: (status) => status >= 200 && status < 400
    });

    const buffer = Buffer.from(response.data);
    if (buffer.length === 0 || buffer.length > maxBytes) {
      return null;
    }

    const path = buildAssetPath(pageFolder, asset.url, assetIndex);
    zip.file(path, buffer);

    return {
      sourceUrl: asset.url,
      filePath: path,
      bytes: buffer.length,
      contentType: String(response.headers["content-type"] || "application/octet-stream")
    };
  } catch {
    return null;
  }
}

export async function scrapeWebsiteToZip(options: ScraperOptions): Promise<ScrapeZipResult> {
  const startNormalized = normalizeUrl(options.startUrl);
  if (!startNormalized) {
    throw new Error("Invalid URL. Please provide a valid http(s) address.");
  }

  const start = new URL(startNormalized);
  const startedAt = new Date();
  const zip = new JSZip();
  const queue: QueueItem[] = [{ url: start.toString(), depth: 0 }];
  const visited = new Set<string>();
  const blockedByRobots: string[] = [];
  const failed: Array<{ url: string; reason: string }> = [];
  const pages: PageResult[] = [];

  let filesWritten = 0;
  let bytesDownloaded = 0;
  let assetsDownloaded = 0;

  const robotsText = options.respectRobots
    ? await readRobots(start, options.requestTimeoutMs)
    : null;
  const robots = robotsParser(`${start.origin}/robots.txt`, robotsText || "");

  if (robotsText) {
    zip.file("site/robots.txt", robotsText);
    filesWritten += 1;
  }

  const sitemapUrl = `${start.origin}/sitemap.xml`;
  try {
    const sitemap = await axios.get<string>(sitemapUrl, {
      timeout: options.requestTimeoutMs,
      responseType: "text",
      headers: { "User-Agent": USER_AGENT, Accept: "application/xml,text/xml,*/*;q=0.8" },
      validateStatus: (status) => status < 500
    });
    if (sitemap.status >= 200 && sitemap.status < 400) {
      zip.file("site/sitemap.xml", sitemap.data);
      filesWritten += 1;
    }
  } catch {
    // Sitemap is optional.
  }

  const assetDownloadLimiter = pLimit(4);

  while (queue.length > 0 && pages.length < options.maxPages) {
    const current = queue.shift() as QueueItem;
    const currentUrl = normalizeUrl(current.url);
    if (!currentUrl || visited.has(currentUrl)) {
      continue;
    }
    if (current.depth > options.maxDepth) {
      continue;
    }

    visited.add(currentUrl);

    if (options.respectRobots) {
      const allowed = robots.isAllowed(currentUrl, USER_AGENT);
      if (allowed === false) {
        blockedByRobots.push(currentUrl);
        continue;
      }
    }

    try {
      const response = await axios.get<string>(currentUrl, {
        timeout: options.requestTimeoutMs,
        responseType: "text",
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
        },
        maxContentLength: 15 * 1024 * 1024,
        maxBodyLength: 15 * 1024 * 1024,
        validateStatus: (status) => status >= 200 && status < 400
      });

      const contentType = String(response.headers["content-type"] || "text/html");
      if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
        continue;
      }

      const html = response.data || "";
      const pageIndex = pages.length + 1;
      const pageFolder = makePageFolderName(pageIndex, currentUrl);
      const page = createPageRecord(
        pageIndex,
        currentUrl,
        current.depth,
        response.status,
        contentType,
        html
      );
      const originForPage = new URL(currentUrl);
      page.links = page.links.map((link) => {
        const absolute = normalizeUrl(link.href, currentUrl) || link.href;
        let internal = false;
        try {
          const parsed = new URL(absolute);
          internal = sameDomain(parsed, originForPage, options.includeSubdomains);
        } catch {
          internal = false;
        }
        return {
          ...link,
          href: absolute,
          internal
        };
      });

      pages.push(page);

      zip.file(`pages/${pageFolder}/raw.html`, html);
      zip.file(
        `pages/${pageFolder}/text.txt`,
        stripText(cheerio.load(html)("body").text() || "")
      );
      zip.file(`pages/${pageFolder}/meta.json`, JSON.stringify(page, null, 2));
      zip.file(
        `pages/${pageFolder}/links.json`,
        JSON.stringify(
          {
            url: page.url,
            total: page.links.length,
            internal: page.links.filter((x) => x.internal).length,
            external: page.links.filter((x) => !x.internal).length,
            links: page.links
          },
          null,
          2
        )
      );
      zip.file(
        `pages/${pageFolder}/assets.json`,
        JSON.stringify(
          {
            url: page.url,
            total: page.assets.length,
            byType: page.assets.reduce<Record<string, number>>((acc, item) => {
              acc[item.type] = (acc[item.type] || 0) + 1;
              return acc;
            }, {}),
            assets: page.assets
          },
          null,
          2
        )
      );
      filesWritten += 5;

      if (options.downloadAssets && page.assets.length > 0) {
        const chosenAssets = page.assets.slice(0, options.assetLimitPerPage);
        const tasks = chosenAssets.map((asset, idx) =>
          assetDownloadLimiter(async () => {
            if (bytesDownloaded >= options.maxTotalAssetBytes) {
              return null;
            }
            const remainingBudget = options.maxTotalAssetBytes - bytesDownloaded;
            const perFileLimit = Math.min(options.maxAssetBytesPerFile, remainingBudget);
            if (perFileLimit <= 0) {
              return null;
            }
            return downloadAsset(
              zip,
              pageFolder,
              asset,
              idx + 1,
              options.requestTimeoutMs,
              perFileLimit
            );
          })
        );
        const downloaded = await Promise.all(tasks);
        const downloadedValid = downloaded.filter(Boolean) as DownloadedAsset[];
        if (downloadedValid.length > 0) {
          zip.file(
            `pages/${pageFolder}/downloaded-assets.json`,
            JSON.stringify(downloadedValid, null, 2)
          );
          filesWritten += 1;
        }
        for (const item of downloadedValid) {
          assetsDownloaded += 1;
          bytesDownloaded += item.bytes;
          filesWritten += 1;
        }
      }

      const discoveredLinks = buildInternalLinks(
        page.links,
        start,
        options.includeSubdomains
      ).filter((link) => !visited.has(link));

      for (const discoveredLink of discoveredLinks) {
        if (queue.length + pages.length >= options.maxPages * 4) {
          break;
        }
        queue.push({ url: discoveredLink, depth: current.depth + 1 });
      }
    } catch (error) {
      failed.push({
        url: currentUrl,
        reason: error instanceof Error ? error.message : "Unknown error"
      });
    }
  }

  const finishedAt = new Date();
  const stats: CrawlStats = {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    elapsedMs: finishedAt.getTime() - startedAt.getTime(),
    pagesVisited: pages.length,
    pagesRequested: visited.size,
    filesWritten,
    assetsDownloaded,
    bytesDownloaded
  };

  zip.file(
    "manifest.json",
    JSON.stringify(
      {
        source: start.toString(),
        options,
        stats,
        blockedByRobots,
        failed,
        pages: pages.map((p) => ({
          index: p.index,
          url: p.url,
          depth: p.depth,
          title: p.title,
          links: p.links.length,
          assets: p.assets.length
        }))
      },
      null,
      2
    )
  );

  zip.file(
    "site/urls.txt",
    pages.map((p) => p.url).join("\n")
  );

  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const host = toSafeSegment(start.hostname);
  const fileName = `scrape_${host}_${Date.now()}.zip`;

  return {
    fileName,
    contentType: "application/zip",
    data: buffer
  };
}
