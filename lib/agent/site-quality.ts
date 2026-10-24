import { getAllFiles, resolveSite } from "./sites";

/**
 * Senior-developer quality audit for generated websites: deterministic
 * static checks over the site's files (copy quality, form integrity,
 * accessibility basics, SEO setup, component-library discipline,
 * responsive/perf smells). Returns a 0–100 score with concrete issues
 * and fixes — the agent runs it before preview/deploy and fixes what it
 * flags, the way a senior dev runs lint + review before shipping.
 */

export interface QualityIssue {
  severity: "error" | "warning" | "info";
  category: string;
  file?: string;
  message: string;
  fix: string;
}

export interface SiteQualityReport {
  ok: boolean;
  site?: string;
  name?: string;
  score?: number;
  grade?: string;
  pages?: number;
  files?: number;
  metrics?: Record<string, number>;
  strengths?: string[];
  issues?: QualityIssue[];
  error?: string;
}

const SCAFFOLD_PREFIXES = ["components/ui/", "components/site/", "components/sections/"];

function isScaffold(path: string): boolean {
  return SCAFFOLD_PREFIXES.some((p) => path.startsWith(p));
}

function count(haystack: string, re: RegExp): number {
  return (haystack.match(re) || []).length;
}

export async function auditSiteQuality(idOrSlug: string): Promise<SiteQualityReport> {
  const site = await resolveSite(idOrSlug).catch(() => null);
  if (!site) return { ok: false, error: `Site "${idOrSlug}" not found` };
  const files = await getAllFiles(site.id);
  const byPath = new Map(files.map((f) => [f.path, f.content]));
  const issues: QualityIssue[] = [];
  const strengths: string[] = [];
  const add = (i: QualityIssue) => issues.push(i);

  const pages = files.filter((f) => f.path.startsWith("app/") && f.path.endsWith("page.jsx"));
  const custom = files.filter(
    (f) => (f.path.endsWith(".jsx") || f.path.endsWith(".js")) && !isScaffold(f.path)
  );
  const siteData = byPath.get("lib/site-data.js") || "";

  let rawButtons = 0;
  let rawInputs = 0;
  let inlineSvgs = 0;
  let hashLinks = 0;
  let blankNoRel = 0;
  let imgNoAlt = 0;
  let responsiveHits = 0;
  let sectionImports = 0;
  let clientFiles = 0;

  for (const f of custom) {
    const c = f.content;
    const isPage = f.path.endsWith("page.jsx");
    rawButtons += count(c, /<button[\s>]/g);
    rawInputs += count(c, /<(input|textarea|select)[\s>]/g);
    inlineSvgs += count(c, /<svg[\s>]/g);
    hashLinks += count(c, /href=["']#["']/g);
    imgNoAlt += count(c, /<img(?![^>]*\balt=)/g);
    responsiveHits += count(c, /\b(sm|md|lg|xl):/g);
    if (c.includes("@/components/sections/")) sectionImports++;
    if (c.includes('"use client"')) clientFiles++;

    if (/lorem ipsum/i.test(c)) {
      add({ severity: "error", category: "copy", file: f.path, message: "Lorem ipsum placeholder copy is still on the page.", fix: "Write real, specific copy for this business — a senior site never ships filler text." });
    }
    if (/\b(TODO|FIXME)\b/.test(c)) {
      add({ severity: "warning", category: "copy", file: f.path, message: "TODO/FIXME left in the code.", fix: "Finish it or remove it before presenting the site as done." });
    }
    if (/dangerouslySetInnerHTML/.test(c)) {
      add({ severity: "error", category: "security", file: f.path, message: "dangerouslySetInnerHTML is used.", fix: "Render text as JSX instead; raw HTML is an XSS risk and never needed for these sites." });
    }
    const blanks = count(c, /target=["']_blank["']/g);
    const rels = count(c, /rel=["'][^"']*noreferrer/g);
    if (blanks > rels) {
      blankNoRel += blanks - rels;
      add({ severity: "warning", category: "security", file: f.path, message: "A target=_blank link is missing rel=\"noreferrer\".", fix: "Add rel=\"noreferrer\" to every external link that opens a new tab." });
    }
    if (isPage) {
      if (!/export default/.test(c)) {
        add({ severity: "error", category: "build", file: f.path, message: "Page has no default export — it will not render.", fix: "Export a default React component from the page file." });
      }
      const h1s = count(c, /<h1[\s>]/g);
      const hasHeroH1 = c.includes("HeroSection") || c.includes("PageIntro");
      if (h1s === 0 && !hasHeroH1) {
        add({ severity: "warning", category: "seo", file: f.path, message: "Page has no h1 (and uses no HeroSection/PageIntro, which provide one).", fix: "Give the page exactly one clear h1 — use HeroSection or PageIntro." });
      }
      if (h1s > 1) {
        add({ severity: "warning", category: "seo", file: f.path, message: `Page has ${h1s} h1 elements.`, fix: "Keep exactly one h1 per page; demote the others to h2/h3." });
      }
      if (!/export const metadata/.test(c) && f.path !== "app/page.jsx") {
        add({ severity: "info", category: "seo", file: f.path, message: "Route page has no page-specific metadata export.", fix: "Add export const metadata = { title, description } so the route ranks and shares well." });
      }
      const hasForm = /(<form[\s>]|onSubmit)/.test(c);
      const usesBackend = c.includes("LeadForm") || c.includes("submitForm");
      if (hasForm && !usesBackend) {
        add({ severity: "error", category: "forms", file: f.path, message: "This page has a form that does not use LeadForm/submitForm — submissions will be lost.", fix: "Rebuild the form with LeadForm from @/components/site/lead-form (or submitForm for custom layouts)." });
      }
      if (f.content.length > 35000) {
        add({ severity: "warning", category: "architecture", file: f.path, message: `Page file is ${(f.content.length / 1024).toFixed(0)}KB — too much in one file.`, fix: "Move content data into lib/ data files and compose sections; keep pages lean." });
      }
    }
  }

  if (rawButtons > 0) {
    add({ severity: "warning", category: "ui", message: `${rawButtons} raw <button> element(s) in custom code.`, fix: "Use the library Button (@/components/ui/button) — consistent variants, focus rings and sizes." });
  }
  if (rawInputs > 0) {
    add({ severity: "warning", category: "ui", message: `${rawInputs} raw input/textarea/select element(s) in custom code.`, fix: "Use Input/Textarea/Label from @/components/ui, or LeadForm for whole forms." });
  }
  if (inlineSvgs > 0) {
    add({ severity: "warning", category: "ui", message: `${inlineSvgs} inline <svg> icon(s) in custom code.`, fix: "Use Lucide icons (lucide-react) — never hand-drawn inline SVG." });
  }
  if (hashLinks > 0) {
    add({ severity: "warning", category: "ux", message: `${hashLinks} dead href="#" link(s).`, fix: "Point every link somewhere real (a route or an in-page anchor that exists)." });
  }
  if (imgNoAlt > 0) {
    add({ severity: "warning", category: "accessibility", message: `${imgNoAlt} <img> tag(s) without alt text.`, fix: "Prefer next/image and always write meaningful alt text (or alt=\"\" for decoration)." });
  }
  if (pages.length > 0 && responsiveHits === 0) {
    add({ severity: "warning", category: "responsive", message: "No responsive (sm:/md:/lg:) classes anywhere in custom code.", fix: "Design mobile-first and verify each breakpoint — sections from the library already handle most of this." });
  }

  // Site data / SEO foundation
  if (!siteData) {
    add({ severity: "error", category: "seo", message: "lib/site-data.js is missing — layout, header, footer and SEO routes depend on it.", fix: "Recreate lib/site-data.js with name, tagline, description, nav, contact and theme." });
  } else {
    if (!/url:\s*"https?:\/\//.test(siteData)) {
      add({ severity: "error", category: "seo", file: "lib/site-data.js", message: "siteData has no valid url — sitemap/robots go wrong and SEO metadata degrades.", fix: "Add url: \"https://<slug>.veritask.site\" to siteData (the site's public address)." });
    }
    if (/Rewrite this/.test(siteData) || /tell visitors, in one or two sentences/i.test(siteData)) {
      add({ severity: "error", category: "seo", file: "lib/site-data.js", message: "The SEO description is still the starter placeholder text.", fix: "Write a real 50–160 character description: what the business offers, for whom, and why." });
    }
    const desc = siteData.match(/description:\s*"([^"]*)"/)?.[1] || "";
    if (desc && (desc.length < 40 || desc.length > 200)) {
      add({ severity: "warning", category: "seo", file: "lib/site-data.js", message: `SEO description is ${desc.length} chars (ideal 50–160).`, fix: "Tighten the description to one or two benefit-led sentences." });
    }
    if (/primary:\s*"oklch\(0\.205 0 0\)"/.test(siteData)) {
      add({ severity: "info", category: "branding", file: "lib/site-data.js", message: "Brand color is still the scaffold's default black.", fix: "Pick a deliberate brand color in theme.primary (unless the brand truly is monochrome)." });
    }
    if (!/email:\s*"[^"]+"/.test(siteData)) {
      add({ severity: "info", category: "content", file: "lib/site-data.js", message: "No contact email in siteData — footer and contact section show less.", fix: "Add the business's real contact email/phone/location when the user provides them." });
    }
  }

  // Strengths worth reporting
  if (sectionImports > 0) strengths.push(`Composes the senior section library in ${sectionImports} file(s)`);
  if (custom.some((f) => f.content.includes("LeadForm") || f.content.includes("submitForm"))) {
    strengths.push("Forms save to the submissions inbox (LeadForm/submitForm)");
  }
  if (byPath.has("app/robots.js") && byPath.has("app/sitemap.js")) strengths.push("robots.txt + sitemap wired to siteData");
  if (siteData && !/Rewrite this/.test(siteData)) strengths.push("Site data (brand + SEO) is customized");
  if (responsiveHits >= 10) strengths.push("Responsive classes used throughout");
  if (pages.length > 1) strengths.push(`${pages.length} routes with a shared layout (header/footer/SEO)`);

  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.filter((i) => i.severity === "warning").length;
  const infos = issues.filter((i) => i.severity === "info").length;
  const score = Math.max(
    0,
    100 - Math.min(48, errors * 12) - Math.min(32, warnings * 4) - Math.min(5, infos)
  );
  const grade = score >= 90 ? "A" : score >= 80 ? "B" : score >= 65 ? "C" : score >= 50 ? "D" : "F";

  return {
    ok: true,
    site: site.slug,
    name: site.name,
    score,
    grade,
    pages: pages.length,
    files: files.length,
    metrics: {
      errors,
      warnings,
      infos,
      rawButtons,
      rawInputs,
      inlineSvgs,
      hashLinks,
      imagesMissingAlt: imgNoAlt,
      responsiveClasses: responsiveHits,
      sectionLibraryFiles: sectionImports,
      clientComponents: clientFiles,
    },
    strengths,
    issues: issues.slice(0, 30),
  };
}
