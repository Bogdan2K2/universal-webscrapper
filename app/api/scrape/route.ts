import { NextRequest } from "next/server";
import { scrapeWebsiteToZip } from "@/lib/scraper";

export const runtime = "nodejs";
export const maxDuration = 60;

interface RequestBody {
  url?: string;
  maxPages?: number;
  maxDepth?: number;
  includeSubdomains?: boolean;
  respectRobots?: boolean;
  downloadAssets?: boolean;
  assetLimitPerPage?: number;
  maxAssetMbPerFile?: number;
  maxTotalAssetMb?: number;
  timeoutSeconds?: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const payload = (await request.json()) as RequestBody;

    if (!payload.url || typeof payload.url !== "string") {
      return Response.json({ error: "Missing URL." }, { status: 400 });
    }

    const result = await scrapeWebsiteToZip({
      startUrl: payload.url.trim(),
      maxPages: clamp(Number(payload.maxPages || 20), 1, 200),
      maxDepth: clamp(Number(payload.maxDepth || 2), 0, 8),
      includeSubdomains: Boolean(payload.includeSubdomains ?? false),
      respectRobots: Boolean(payload.respectRobots ?? true),
      downloadAssets: Boolean(payload.downloadAssets ?? false),
      assetLimitPerPage: clamp(Number(payload.assetLimitPerPage || 10), 0, 200),
      maxAssetBytesPerFile: clamp(Number(payload.maxAssetMbPerFile || 3), 1, 50) * 1024 * 1024,
      maxTotalAssetBytes: clamp(Number(payload.maxTotalAssetMb || 25), 1, 500) * 1024 * 1024,
      requestTimeoutMs: clamp(Number(payload.timeoutSeconds || 12), 4, 45) * 1000
    });

    return new Response(new Uint8Array(result.data), {
      status: 200,
      headers: {
        "Content-Type": result.contentType,
        "Content-Disposition": `attachment; filename=\"${result.fileName}\"`,
        "Cache-Control": "no-store"
      }
    });
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Unexpected scraping error"
      },
      { status: 500 }
    );
  }
}
