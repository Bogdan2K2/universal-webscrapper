"use client";

import { useMemo, useState } from "react";

interface FormState {
  url: string;
  maxPages: number;
  maxDepth: number;
  includeSubdomains: boolean;
  respectRobots: boolean;
  downloadAssets: boolean;
  assetLimitPerPage: number;
  maxAssetMbPerFile: number;
  maxTotalAssetMb: number;
  timeoutSeconds: number;
}

const initialForm: FormState = {
  url: "https://example.com",
  maxPages: 20,
  maxDepth: 2,
  includeSubdomains: false,
  respectRobots: true,
  downloadAssets: false,
  assetLimitPerPage: 10,
  maxAssetMbPerFile: 3,
  maxTotalAssetMb: 25,
  timeoutSeconds: 12
};

export default function Home(): React.ReactElement {
  const [form, setForm] = useState<FormState>(initialForm);
  const [isRunning, setIsRunning] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string>("");

  const canSubmit = useMemo(
    () => form.url.trim().length > 0 && !isRunning,
    [form.url, isRunning]
  );

  async function onSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError("");
    setStatus("Starting crawl and building your ZIP...");
    setIsRunning(true);

    try {
      const response = await fetch("/api/scrape", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form)
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error || "Scrape failed.");
      }

      const blob = await response.blob();
      const fileName =
        response.headers
          .get("Content-Disposition")
          ?.match(/filename="?(.*?)"?$/)?.[1]
          ?.trim() || `scrape_${Date.now()}.zip`;

      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      anchor.click();
      URL.revokeObjectURL(url);

      setStatus("Complete. ZIP downloaded.");
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Unexpected error.");
      setStatus("");
    } finally {
      setIsRunning(false);
    }
  }

  return (
    <main className="page-wrap">
      <section className="hero-card">
        <h1>Universal Web Scrapper</h1>
        <p className="subtitle">
          Enter any website and export structured files: raw HTML, clean text, links, assets,
          metadata, manifest, and optional downloaded assets.
        </p>
      </section>

      <section className="form-card">
        <form onSubmit={onSubmit}>
          <label>
            Target URL
            <input
              required
              type="url"
              value={form.url}
              onChange={(event) => setForm((prev) => ({ ...prev, url: event.target.value }))}
              placeholder="https://example.com"
            />
          </label>

          <div className="grid two">
            <label>
              Max Pages
              <input
                type="number"
                min={1}
                max={200}
                value={form.maxPages}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, maxPages: Number(event.target.value) }))
                }
              />
            </label>
            <label>
              Max Depth
              <input
                type="number"
                min={0}
                max={8}
                value={form.maxDepth}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, maxDepth: Number(event.target.value) }))
                }
              />
            </label>
          </div>

          <div className="grid two">
            <label>
              Asset Limit / Page
              <input
                type="number"
                min={0}
                max={200}
                value={form.assetLimitPerPage}
                onChange={(event) =>
                  setForm((prev) => ({
                    ...prev,
                    assetLimitPerPage: Number(event.target.value)
                  }))
                }
              />
            </label>
            <label>
              Timeout Seconds
              <input
                type="number"
                min={4}
                max={45}
                value={form.timeoutSeconds}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, timeoutSeconds: Number(event.target.value) }))
                }
              />
            </label>
          </div>

          <div className="grid two">
            <label>
              Max Asset MB / File
              <input
                type="number"
                min={1}
                max={50}
                value={form.maxAssetMbPerFile}
                onChange={(event) =>
                  setForm((prev) => ({
                    ...prev,
                    maxAssetMbPerFile: Number(event.target.value)
                  }))
                }
              />
            </label>
            <label>
              Max Total Asset MB
              <input
                type="number"
                min={1}
                max={500}
                value={form.maxTotalAssetMb}
                onChange={(event) =>
                  setForm((prev) => ({
                    ...prev,
                    maxTotalAssetMb: Number(event.target.value)
                  }))
                }
              />
            </label>
          </div>

          <div className="grid checks">
            <label className="check">
              <input
                type="checkbox"
                checked={form.includeSubdomains}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, includeSubdomains: event.target.checked }))
                }
              />
              Include subdomains
            </label>

            <label className="check">
              <input
                type="checkbox"
                checked={form.respectRobots}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, respectRobots: event.target.checked }))
                }
              />
              Respect robots.txt
            </label>

            <label className="check">
              <input
                type="checkbox"
                checked={form.downloadAssets}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, downloadAssets: event.target.checked }))
                }
              />
              Download binary assets
            </label>
          </div>

          <button type="submit" disabled={!canSubmit}>
            {isRunning ? "Scraping..." : "Scrape and Download ZIP"}
          </button>
        </form>

        {status && <p className="status">{status}</p>}
        {error && <p className="error">{error}</p>}
      </section>
    </main>
  );
}
