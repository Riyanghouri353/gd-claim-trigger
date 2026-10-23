import { createHash } from "crypto";
import { getServiceClient } from "./supabase";
import { getHostingConfig } from "./hosting";

/**
 * Website builder: the agent authors a frontend-only Next.js site as files
 * in the DB (scaffold + pages/components), deploys it to Vercel via the
 * REST API for preview, and publishes it to <slug>.veritask.site by
 * attaching the domain on Vercel and creating the DNS record on Cloudflare.
 */

export const SITE_APEX = "veritask.site";
const MAX_FILES = 90;
const MAX_FILE_CHARS = 200_000;

export interface SiteRow {
  id: string;
  name: string;
  slug: string;
  vercel_project_id: string | null;
  preview_url: string | null;
  live_url: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

const RESERVED_SLUGS = new Set([
  "www", "api", "app", "mail", "admin", "support", "help", "blog", "shop",
  "dashboard", "login", "agent", "claim", "claims", "veritask", "test",
]);

/**
 * Preinstalled shadcn/ui component library (JSX) + the cn() helper.
 * Generated sites compose these instead of hand-rolling buttons/cards —
 * the agent imports from "@/components/ui/…" and "@/lib/utils".
 */
const UI_COMPONENT_FILES: Record<string, string> = {
  "lib/utils.js": `import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs) {
  return twMerge(clsx(inputs));
}
`,
  "components/ui/button.jsx": `import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow-xs hover:bg-primary/90",
        destructive:
          "bg-destructive text-white shadow-xs hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60",
        outline:
          "border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50",
        secondary: "bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        sm: "h-8 rounded-md gap-1.5 px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        icon: "size-9",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  }
);

function Button({ className, variant, size, asChild = false, ...props }) {
  const Comp = asChild ? Slot : "button";
  return <Comp data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { Button, buttonVariants };
`,
  "components/ui/badge.jsx": `import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center justify-center rounded-md border px-2 py-0.5 text-xs font-medium w-fit whitespace-nowrap shrink-0 [&>svg]:size-3 gap-1 [&>svg]:pointer-events-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] transition-[color,box-shadow] overflow-hidden",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground [a&]:hover:bg-primary/90",
        secondary: "border-transparent bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90",
        destructive: "border-transparent bg-destructive text-white [a&]:hover:bg-destructive/90",
        outline: "text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

function Badge({ className, variant, asChild = false, ...props }) {
  const Comp = asChild ? Slot : "span";
  return <Comp data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
`,
  "components/ui/card.jsx": `import * as React from "react";
import { cn } from "@/lib/utils";

function Card({ className, ...props }) {
  return <div data-slot="card" className={cn("bg-card text-card-foreground flex flex-col gap-6 rounded-xl border py-6 shadow-sm", className)} {...props} />;
}
function CardHeader({ className, ...props }) {
  return <div data-slot="card-header" className={cn("flex flex-col gap-1.5 px-6", className)} {...props} />;
}
function CardTitle({ className, ...props }) {
  return <div data-slot="card-title" className={cn("leading-none font-semibold", className)} {...props} />;
}
function CardDescription({ className, ...props }) {
  return <div data-slot="card-description" className={cn("text-muted-foreground text-sm", className)} {...props} />;
}
function CardContent({ className, ...props }) {
  return <div data-slot="card-content" className={cn("px-6", className)} {...props} />;
}
function CardFooter({ className, ...props }) {
  return <div data-slot="card-footer" className={cn("flex items-center px-6", className)} {...props} />;
}

export { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent };
`,
  "components/ui/input.jsx": `import * as React from "react";
import { cn } from "@/lib/utils";

function Input({ className, type, ...props }) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground dark:bg-input/30 border-input flex h-9 w-full min-w-0 rounded-md border bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
        "aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
        className
      )}
      {...props}
    />
  );
}

export { Input };
`,
  "components/ui/textarea.jsx": `import * as React from "react";
import { cn } from "@/lib/utils";

function Textarea({ className, ...props }) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:bg-input/30 flex field-sizing-content min-h-16 w-full rounded-md border bg-transparent px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        className
      )}
      {...props}
    />
  );
}

export { Textarea };
`,
  "components/ui/label.jsx": `import * as React from "react";
import * as LabelPrimitive from "@radix-ui/react-label";
import { cn } from "@/lib/utils";

function Label({ className, ...props }) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn(
        "flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        className
      )}
      {...props}
    />
  );
}

export { Label };
`,
  "components/ui/separator.jsx": `import * as React from "react";
import * as SeparatorPrimitive from "@radix-ui/react-separator";
import { cn } from "@/lib/utils";

function Separator({ className, orientation = "horizontal", decorative = true, ...props }) {
  return (
    <SeparatorPrimitive.Root
      data-slot="separator-root"
      decorative={decorative}
      orientation={orientation}
      className={cn(
        "bg-border shrink-0 data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px",
        className
      )}
      {...props}
    />
  );
}

export { Separator };
`,
  "components/ui/avatar.jsx": `import * as React from "react";
import * as AvatarPrimitive from "@radix-ui/react-avatar";
import { cn } from "@/lib/utils";

function Avatar({ className, ...props }) {
  return <AvatarPrimitive.Root data-slot="avatar" className={cn("relative flex size-8 shrink-0 overflow-hidden rounded-full", className)} {...props} />;
}
function AvatarImage({ className, ...props }) {
  return <AvatarPrimitive.Image data-slot="avatar-image" className={cn("aspect-square size-full", className)} {...props} />;
}
function AvatarFallback({ className, ...props }) {
  return <AvatarPrimitive.Fallback data-slot="avatar-fallback" className={cn("bg-muted flex size-full items-center justify-center rounded-full", className)} {...props} />;
}

export { Avatar, AvatarImage, AvatarFallback };
`,
  "components/ui/accordion.jsx": `import * as React from "react";
import * as AccordionPrimitive from "@radix-ui/react-accordion";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

function Accordion({ ...props }) {
  return <AccordionPrimitive.Root data-slot="accordion" {...props} />;
}
function AccordionItem({ className, ...props }) {
  return <AccordionPrimitive.Item data-slot="accordion-item" className={cn("border-b last:border-b-0", className)} {...props} />;
}
function AccordionTrigger({ className, children, ...props }) {
  return (
    <AccordionPrimitive.Header className="flex">
      <AccordionPrimitive.Trigger
        data-slot="accordion-trigger"
        className={cn(
          "focus-visible:border-ring focus-visible:ring-ring/50 flex flex-1 items-start justify-between gap-4 rounded-md py-4 text-left text-sm font-medium transition-all outline-none hover:underline focus-visible:ring-[3px] disabled:pointer-events-none disabled:opacity-50 [&[data-state=open]>svg]:rotate-180",
          className
        )}
        {...props}
      >
        {children}
        <ChevronDown className="text-muted-foreground pointer-events-none size-4 shrink-0 translate-y-0.5 transition-transform duration-200" />
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  );
}
function AccordionContent({ className, children, ...props }) {
  return (
    <AccordionPrimitive.Content
      data-slot="accordion-content"
      className="data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down overflow-hidden text-sm"
      {...props}
    >
      <div className={cn("pt-0 pb-4", className)}>{children}</div>
    </AccordionPrimitive.Content>
  );
}

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent };
`,
  "components/ui/tabs.jsx": `import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "@/lib/utils";

function Tabs({ className, ...props }) {
  return <TabsPrimitive.Root data-slot="tabs" className={cn("flex flex-col gap-2", className)} {...props} />;
}
function TabsList({ className, ...props }) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn("bg-muted text-muted-foreground inline-flex h-9 w-fit items-center justify-center rounded-lg p-[3px]", className)}
      {...props}
    />
  );
}
function TabsTrigger({ className, ...props }) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "data-[state=active]:bg-background dark:data-[state=active]:text-foreground focus-visible:border-ring focus-visible:ring-ring/50 inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-sm font-medium whitespace-nowrap transition-[color,box-shadow] focus-visible:ring-[3px] focus-visible:outline-1 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:shadow-sm [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    />
  );
}
function TabsContent({ className, ...props }) {
  return <TabsPrimitive.Content data-slot="tabs-content" className={cn("flex-1 outline-none", className)} {...props} />;
}

export { Tabs, TabsList, TabsTrigger, TabsContent };
`,
  "components/ui/dialog.jsx": `import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

function Dialog({ ...props }) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}
function DialogTrigger({ ...props }) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}
function DialogClose({ ...props }) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}
function DialogPortal({ ...props }) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}
function DialogOverlay({ className, ...props }) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn("data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/50", className)}
      {...props}
    />
  );
}
function DialogContent({ className, children, ...props }) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          "bg-background data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-lg border p-6 shadow-lg duration-200 sm:max-w-lg",
          className
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close className="ring-offset-background focus:ring-ring data-[state=open]:bg-accent data-[state=open]:text-muted-foreground absolute top-4 right-4 rounded-xs opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4">
          <X />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}
function DialogHeader({ className, ...props }) {
  return <div data-slot="dialog-header" className={cn("flex flex-col gap-2 text-center sm:text-left", className)} {...props} />;
}
function DialogFooter({ className, ...props }) {
  return <div data-slot="dialog-footer" className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)} {...props} />;
}
function DialogTitle({ className, ...props }) {
  return <DialogPrimitive.Title data-slot="dialog-title" className={cn("text-lg leading-none font-semibold", className)} {...props} />;
}
function DialogDescription({ className, ...props }) {
  return <DialogPrimitive.Description data-slot="dialog-description" className={cn("text-muted-foreground text-sm", className)} {...props} />;
}

export {
  Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogOverlay, DialogPortal, DialogTitle, DialogTrigger,
};
`,
};

/**
 * Senior-developer section library: production-grade, composable page
 * sections (hero, features, pricing, FAQ, contact…) built on the shadcn/ui
 * primitives. The agent composes these instead of inventing layout markup
 * section by section — consistent spacing, semantics and accessibility.
 */
const SECTION_FILES: Record<string, string> = {
  "components/sections/site-shell.jsx": `import Link from "next/link";
import { siteData } from "@/lib/site-data";
import { cn } from "@/lib/utils";

export function Container({ className, ...props }) {
  return <div className={cn("mx-auto w-full max-w-6xl px-5 sm:px-6 lg:px-8", className)} {...props} />;
}

export function Section({ className, ...props }) {
  return <section className={cn("py-16 sm:py-20 lg:py-24", className)} {...props} />;
}

export function SectionHeading({ eyebrow, title, description, align = "center", className }) {
  return (
    <div className={cn("max-w-2xl", align === "center" ? "mx-auto text-center" : "text-left", className)}>
      {eyebrow ? (
        <p className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-primary">{eyebrow}</p>
      ) : null}
      <h2 className="text-balance text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h2>
      {description ? (
        <p className="mt-4 text-pretty text-base leading-7 text-muted-foreground sm:text-lg">{description}</p>
      ) : null}
    </div>
  );
}

export function SiteFooter() {
  const year = new Date().getFullYear();
  return (
    <footer className="border-t bg-muted/30">
      <Container className="grid gap-10 py-12 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <p className="text-base font-semibold tracking-tight">{siteData.name}</p>
          <p className="mt-3 max-w-xs text-sm leading-6 text-muted-foreground">{siteData.tagline}</p>
        </div>
        <nav aria-label="Footer">
          <p className="text-sm font-semibold">Explore</p>
          <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
            {siteData.nav.map((item) => (
              <li key={item.href}>
                <Link className="hover:text-foreground" href={item.href}>{item.label}</Link>
              </li>
            ))}
          </ul>
        </nav>
        <div>
          <p className="text-sm font-semibold">Contact</p>
          <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
            {siteData.contact.email ? <li>{siteData.contact.email}</li> : null}
            {siteData.contact.phone ? <li>{siteData.contact.phone}</li> : null}
            {siteData.contact.location ? <li>{siteData.contact.location}</li> : null}
          </ul>
        </div>
        <div>
          <p className="text-sm font-semibold">Get started</p>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            Tell us what you need and we will reply with clear next steps.
          </p>
          <Link href={siteData.primaryCta.href} className="mt-4 inline-flex text-sm font-medium text-primary hover:underline">
            {siteData.primaryCta.label}
          </Link>
        </div>
      </Container>
      <div className="border-t py-5">
        <Container className="flex flex-col gap-2 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <p>© {year} {siteData.name}. All rights reserved.</p>
          <p>Built with a production-grade Next.js scaffold.</p>
        </Container>
      </div>
    </footer>
  );
}
`,
  "components/sections/site-header.jsx": `"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, Menu, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { siteData } from "@/lib/site-data";
import { Container } from "@/components/sections/site-shell";

export function SiteHeader() {
  const [open, setOpen] = useState(false);
  return (
    <header className="sticky top-0 z-50 border-b bg-background/90 backdrop-blur">
      <Container className="flex h-16 items-center justify-between gap-4">
        <Link href="/" className="text-base font-semibold tracking-tight" aria-label={siteData.name + " — home"}>
          {siteData.name}
        </Link>
        <nav aria-label="Primary" className="hidden items-center gap-1 md:flex">
          {siteData.nav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-md px-3 py-2 text-sm text-muted-foreground transition hover:bg-accent hover:text-foreground"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="hidden md:block">
          <Button asChild size="sm">
            <Link href={siteData.primaryCta.href}>
              {siteData.primaryCta.label} <ArrowRight />
            </Link>
          </Button>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="md:hidden"
          aria-expanded={open}
          aria-label={open ? "Close menu" : "Open menu"}
          onClick={() => setOpen(!open)}
        >
          {open ? <X /> : <Menu />}
        </Button>
      </Container>
      {open ? (
        <nav aria-label="Mobile" className="border-t md:hidden">
          <Container className="grid gap-1 py-4">
            {siteData.nav.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                className="rounded-md px-3 py-2.5 text-sm hover:bg-accent"
              >
                {item.label}
              </Link>
            ))}
            <Button asChild className="mt-2">
              <Link href={siteData.primaryCta.href} onClick={() => setOpen(false)}>
                {siteData.primaryCta.label}
              </Link>
            </Button>
          </Container>
        </nav>
      ) : null}
    </header>
  );
}
`,
  "components/sections/marketing.jsx": `import Link from "next/link";
import { ArrowRight, Check, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Container, Section, SectionHeading } from "@/components/sections/site-shell";
import { cn } from "@/lib/utils";

export function HeroSection({ eyebrow, title, description, primaryCta, secondaryCta, children }) {
  return (
    <Section className="overflow-hidden pb-14 pt-14 sm:pt-20">
      <Container className="text-center">
        {eyebrow ? (
          <Badge variant="secondary" className="mb-5">{eyebrow}</Badge>
        ) : null}
        <h1 className="mx-auto max-w-3xl text-balance text-4xl font-bold leading-[1.05] tracking-tight sm:text-6xl">
          {title}
        </h1>
        {description ? (
          <p className="mx-auto mt-6 max-w-2xl text-pretty text-lg leading-8 text-muted-foreground">{description}</p>
        ) : null}
        {(primaryCta || secondaryCta) && (
          <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
            {primaryCta ? (
              <Button asChild size="lg">
                <Link href={primaryCta.href}>{primaryCta.label} <ArrowRight /></Link>
              </Button>
            ) : null}
            {secondaryCta ? (
              <Button asChild size="lg" variant="outline">
                <Link href={secondaryCta.href}>{secondaryCta.label}</Link>
              </Button>
            ) : null}
          </div>
        )}
        {children}
      </Container>
    </Section>
  );
}

export function FeatureGrid({ eyebrow, title, description, features = [] }) {
  return (
    <Section>
      <Container>
        <SectionHeading eyebrow={eyebrow} title={title} description={description} />
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((f) => (
            <Card key={f.title} className="h-full">
              <CardHeader>
                {f.icon ? <f.icon className="mb-2 size-6 text-primary" aria-hidden="true" /> : null}
                <CardTitle>{f.title}</CardTitle>
                <CardDescription className="leading-6">{f.text}</CardDescription>
              </CardHeader>
            </Card>
          ))}
        </div>
      </Container>
    </Section>
  );
}

export function StatsSection({ stats = [] }) {
  return (
    <Section className="border-y bg-muted/30 py-12 sm:py-14">
      <Container>
        <dl className="grid gap-8 text-center sm:grid-cols-3">
          {stats.map((s) => (
            <div key={s.label}>
              <dt className="order-2 mt-1 block text-sm text-muted-foreground">{s.label}</dt>
              <dd className="text-4xl font-bold tracking-tight">{s.value}</dd>
              {s.detail ? <dd className="mt-1 text-sm text-muted-foreground">{s.detail}</dd> : null}
            </div>
          ))}
        </dl>
      </Container>
    </Section>
  );
}

export function StepsSection({ eyebrow, title, description, steps = [] }) {
  return (
    <Section>
      <Container>
        <SectionHeading eyebrow={eyebrow} title={title} description={description} />
        <ol className="mt-12 grid gap-4 md:grid-cols-3">
          {steps.map((s, i) => (
            <li key={s.title}>
              <Card className="h-full">
                <CardHeader>
                  <span className="mb-3 flex size-9 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
                    {i + 1}
                  </span>
                  <CardTitle>{s.title}</CardTitle>
                  <CardDescription className="leading-6">{s.text}</CardDescription>
                </CardHeader>
              </Card>
            </li>
          ))}
        </ol>
      </Container>
    </Section>
  );
}

export function TestimonialGrid({ eyebrow, title, description, testimonials = [] }) {
  return (
    <Section className="bg-muted/30">
      <Container>
        <SectionHeading eyebrow={eyebrow} title={title} description={description} />
        <div className="mt-12 grid gap-4 md:grid-cols-3">
          {testimonials.map((t) => (
            <Card key={t.name} className="h-full">
              <CardContent className="flex h-full flex-col pt-6">
                <div className="flex gap-0.5 text-primary" aria-label="5 out of 5 stars">
                  {[0, 1, 2, 3, 4].map((i) => (
                    <Star key={i} className="size-4 fill-current" aria-hidden="true" />
                  ))}
                </div>
                <blockquote className="mt-4 flex-1 text-pretty leading-7">“{t.quote}”</blockquote>
                <div className="mt-6 flex items-center gap-3">
                  <Avatar>
                    <AvatarFallback>
                      {t.name.split(" ").map((w) => w[0]).slice(0, 2).join("")}
                    </AvatarFallback>
                  </Avatar>
                  <div>
                    <p className="text-sm font-semibold">{t.name}</p>
                    {t.role ? <p className="text-sm text-muted-foreground">{t.role}</p> : null}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </Container>
    </Section>
  );
}

export function PricingSection({ eyebrow, title, description, plans = [] }) {
  return (
    <Section>
      <Container>
        <SectionHeading eyebrow={eyebrow} title={title} description={description} />
        <div className="mt-12 grid items-stretch gap-4 lg:grid-cols-3">
          {plans.map((p) => (
            <Card key={p.name} className={cn("flex h-full flex-col", p.featured && "border-primary shadow-md")}>
              <CardHeader>
                <div className="flex items-center justify-between gap-3">
                  <CardTitle>{p.name}</CardTitle>
                  {p.featured ? <Badge>Most popular</Badge> : null}
                </div>
                <CardDescription>{p.description}</CardDescription>
                <p className="pt-3">
                  <span className="text-4xl font-bold tracking-tight">{p.price}</span>
                  {p.period ? <span className="text-sm text-muted-foreground"> {p.period}</span> : null}
                </p>
              </CardHeader>
              <CardContent className="flex-1">
                <ul className="space-y-2.5 text-sm">
                  {(p.features || []).map((f) => (
                    <li key={f} className="flex gap-2.5">
                      <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
              <CardFooter>
                <Button asChild className="w-full" variant={p.featured ? "default" : "outline"}>
                  <Link href={p.ctaHref || "#contact"}>{p.cta || "Get started"}</Link>
                </Button>
              </CardFooter>
            </Card>
          ))}
        </div>
      </Container>
    </Section>
  );
}

export function FaqSection({ eyebrow, title, description, faqs = [] }) {
  return (
    <Section>
      <Container className="max-w-3xl">
        <SectionHeading eyebrow={eyebrow} title={title} description={description} />
        <Accordion type="single" collapsible className="mt-10">
          {faqs.map((f, i) => (
            <AccordionItem key={f.q} value={"faq-" + i}>
              <AccordionTrigger>{f.q}</AccordionTrigger>
              <AccordionContent className="leading-7">{f.a}</AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </Container>
    </Section>
  );
}

export function CtaSection({ title, description, cta }) {
  return (
    <Section className="pt-0">
      <Container>
        <div className="rounded-2xl bg-primary px-6 py-12 text-center text-primary-foreground sm:px-12">
          <h2 className="mx-auto max-w-2xl text-balance text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h2>
          {description ? (
            <p className="mx-auto mt-4 max-w-xl text-pretty leading-7 text-primary-foreground/80">{description}</p>
          ) : null}
          {cta ? (
            <Button asChild size="lg" variant="secondary" className="mt-8">
              <Link href={cta.href}>{cta.label} <ArrowRight /></Link>
            </Button>
          ) : null}
        </div>
      </Container>
    </Section>
  );
}
`,
  "components/sections/contact.jsx": `import { Mail, MapPin, Phone } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { LeadForm } from "@/components/site/lead-form";
import { Container, Section, SectionHeading } from "@/components/sections/site-shell";
import { siteData } from "@/lib/site-data";

const DEFAULT_FIELDS = [
  { name: "name", label: "Your name", type: "text", required: true, placeholder: "Full name" },
  { name: "email", label: "Email", type: "email", required: true, placeholder: "you@example.com" },
  { name: "message", label: "Message", type: "textarea", required: true, placeholder: "How can we help?" },
];

export function ContactSection({
  eyebrow = "Contact",
  title = "Contact us",
  description = "Send a message and we will get back to you soon.",
  form = "contact",
  fields = DEFAULT_FIELDS,
  submitLabel = "Send message",
}) {
  const details = [
    { icon: Mail, label: "Email", value: siteData.contact.email },
    { icon: Phone, label: "Phone", value: siteData.contact.phone },
    { icon: MapPin, label: "Location", value: siteData.contact.location },
  ].filter((d) => d.value);
  return (
    <Section id="contact">
      <Container>
        <SectionHeading eyebrow={eyebrow} title={title} description={description} />
        <div className="mx-auto mt-12 grid max-w-5xl gap-8 lg:grid-cols-[1fr_1.2fr]">
          <div className="space-y-5">
            {details.map((d) => (
              <div key={d.label} className="flex items-start gap-4">
                <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <d.icon className="size-5" aria-hidden="true" />
                </span>
                <div>
                  <p className="text-sm font-semibold">{d.label}</p>
                  <p className="mt-0.5 text-sm text-muted-foreground">{d.value}</p>
                </div>
              </div>
            ))}
            <p className="text-sm leading-6 text-muted-foreground">
              Prefer to talk first? Send the form and include your phone number — we reply with clear next steps, not a sales script.
            </p>
          </div>
          <Card>
            <CardContent className="pt-6">
              <LeadForm form={form} fields={fields} submitLabel={submitLabel} />
            </CardContent>
          </Card>
        </div>
      </Container>
    </Section>
  );
}
`,
  "components/sections/states.jsx": `import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Container, Section } from "@/components/sections/site-shell";

export function EmptyState({ icon: Icon, title, text, actionLabel, actionHref }) {
  return (
    <div className="rounded-xl border border-dashed p-10 text-center">
      {Icon ? <Icon className="mx-auto size-8 text-muted-foreground" aria-hidden="true" /> : null}
      <h3 className="mt-4 text-lg font-semibold">{title}</h3>
      {text ? <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">{text}</p> : null}
      {actionLabel && actionHref ? (
        <Button asChild className="mt-6">
          <Link href={actionHref}>{actionLabel}</Link>
        </Button>
      ) : null}
    </div>
  );
}

export function PageIntro({ eyebrow, title, description }) {
  return (
    <Section className="pb-8 pt-14 sm:pt-16">
      <Container>
        {eyebrow ? (
          <p className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-primary">{eyebrow}</p>
        ) : null}
        <h1 className="max-w-3xl text-balance text-4xl font-bold tracking-tight sm:text-5xl">{title}</h1>
        {description ? (
          <p className="mt-5 max-w-2xl text-pretty text-lg leading-8 text-muted-foreground">{description}</p>
        ) : null}
      </Container>
    </Section>
  );
}
`,
};


/** Public base URL of the agent app — generated sites POST form data here. */
export const AGENT_PUBLIC_URL = "https://gd-claim.ghouri.site";

/**
 * Backend kit for generated sites: per-site config + a ready-made lead form.
 * Sites stay static; forms POST to the agent's public submit endpoint and
 * land in the site's submissions inbox.
 */
function backendFiles(slug: string): Record<string, string> {
  return {
    "lib/site-config.js": `// Generated by the scaffold — identifies this site to the agent backend.
export const SITE_SLUG = "${slug}";
export const SITE_API_BASE = "${AGENT_PUBLIC_URL}";
`,
    "components/site/lead-form.jsx": `"use client";

import { useState } from "react";
import { SITE_SLUG, SITE_API_BASE } from "@/lib/site-config";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";

/** Post any form's data to this site's submissions inbox. */
export async function submitForm(formName, data) {
  const res = await fetch(SITE_API_BASE + "/api/sites/" + SITE_SLUG + "/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ form: formName, data }),
  });
  if (!res.ok) throw new Error("Submit failed (" + res.status + ")");
  return res.json();
}

const selectClass =
  "border-input flex h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]";

/**
 * Ready-made lead/contact/order form that SAVES submissions to the site
 * owner's inbox. fields: [{ name, label, type, required, placeholder, options }]
 * type: text | email | tel | number | textarea | select
 */
export function LeadForm({
  form = "contact",
  fields = [],
  submitLabel = "Send",
  successMessage = "Thanks! We received your message and will get back to you soon.",
}) {
  const [values, setValues] = useState({});
  const [hp, setHp] = useState("");
  const [status, setStatus] = useState("idle"); // idle | sending | sent | error

  function set(name, value) {
    setValues((v) => ({ ...v, [name]: value }));
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (hp) {
      setStatus("sent");
      return;
    }
    setStatus("sending");
    try {
      await submitForm(form, values);
      setStatus("sent");
      setValues({});
    } catch {
      setStatus("error");
    }
  }

  if (status === "sent") {
    return (
      <div className="rounded-lg border bg-card p-6 text-center">
        <p className="font-medium">{successMessage}</p>
        <Button variant="ghost" size="sm" className="mt-3" onClick={() => setStatus("idle")}>
          Send another
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {fields.map((f) => (
        <div key={f.name} className="space-y-1.5">
          <Label htmlFor={"lf-" + f.name}>
            {f.label || f.name}
            {f.required ? " *" : ""}
          </Label>
          {f.type === "textarea" ? (
            <Textarea
              id={"lf-" + f.name}
              required={!!f.required}
              placeholder={f.placeholder || ""}
              value={values[f.name] || ""}
              onChange={(e) => set(f.name, e.target.value)}
            />
          ) : f.type === "select" ? (
            <select
              id={"lf-" + f.name}
              required={!!f.required}
              className={selectClass}
              value={values[f.name] || ""}
              onChange={(e) => set(f.name, e.target.value)}
            >
              <option value="">Select…</option>
              {(f.options || []).map((o) => (
                <option key={o} value={o}>{o}</option>
              ))}
            </select>
          ) : (
            <Input
              id={"lf-" + f.name}
              type={f.type || "text"}
              required={!!f.required}
              placeholder={f.placeholder || ""}
              value={values[f.name] || ""}
              onChange={(e) => set(f.name, e.target.value)}
            />
          )}
        </div>
      ))}
      {/* honeypot: humans never see or fill this */}
      <input
        type="text"
        name="company_website"
        tabIndex={-1}
        autoComplete="off"
        className="hidden"
        aria-hidden="true"
        value={hp}
        onChange={(e) => setHp(e.target.value)}
      />
      {status === "error" && (
        <p className="text-sm text-destructive">Something went wrong — please try again.</p>
      )}
      <Button type="submit" disabled={status === "sending"} className="w-full sm:w-auto">
        {status === "sending" ? "Sending…" : submitLabel}
      </Button>
    </form>
  );
}
`,
  };
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export function validateSlug(slug: string): string | null {
  if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(slug)) {
    return "Slug must be 3–40 chars: lowercase letters, numbers and hyphens, starting and ending with a letter or number.";
  }
  if (RESERVED_SLUGS.has(slug)) return `"${slug}" is a reserved subdomain.`;
  return null;
}

/**
 * Per-site content + brand config. Unlike the rest of the scaffold this
 * file belongs to the SITE: the agent edits it (name, tagline, SEO
 * description, nav, contact details, brand color) and it is therefore
 * excluded from the deploy-time scaffold force-sync.
 */
function siteDataFile(name: string, slug: string): string {
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const safeName = esc(name);
  return `// Site content + brand configuration — the agent edits THIS file to
// rebrand or restructure the site; layout, header, footer and SEO routes
// all read from it. Keep nav hrefs in sync with the pages under app/.
export const siteData = {
  name: "${safeName}",
  tagline: "Built to convert visitors into customers",
  description: "${safeName} — tell visitors, in one or two sentences, exactly what you offer, who it is for, and why it is the right choice. Rewrite this: it is the site's search-engine and social-share description.",
  url: "https://${slug}.${SITE_APEX}",
  keywords: ["${safeName}"],
  nav: [
    { label: "Home", href: "/" },
    { label: "Services", href: "/#services" },
    { label: "FAQ", href: "/#faq" },
    { label: "Contact", href: "/#contact" },
  ],
  primaryCta: { label: "Get started", href: "/#contact" },
  contact: {
    email: "",
    phone: "",
    location: "",
  },
  theme: {
    // Brand color (any CSS color). Applied to primary buttons, links,
    // accents and the focus ring across the whole site.
    primary: "oklch(0.205 0 0)",
    primaryForeground: "oklch(0.985 0 0)",
    radius: "0.625rem",
  },
  sitemapRoutes: ["/"],
};
`;
}


function scaffoldFiles(name: string, slug: string): Record<string, string> {
  const base: Record<string, string> = {
    "package.json": JSON.stringify(
      {
        name: slug,
        private: true,
        version: "1.0.0",
        scripts: { dev: "next dev", build: "next build", start: "next start" },
        dependencies: {
          next: "^15.3.0",
          react: "^19.1.0",
          "react-dom": "^19.1.0",
          "lucide-react": "^1.61.0",
          "class-variance-authority": "^0.7.0",
          clsx: "^2.1.0",
          "tailwind-merge": "^3.0.0",
          "@radix-ui/react-slot": "^1.1.0",
          "@radix-ui/react-accordion": "^1.2.0",
          "@radix-ui/react-dialog": "^1.1.0",
          "@radix-ui/react-label": "^2.1.0",
          "@radix-ui/react-separator": "^1.1.0",
          "@radix-ui/react-tabs": "^1.1.0",
          "@radix-ui/react-avatar": "^1.1.0",
        },
        devDependencies: {
          "@tailwindcss/postcss": "^4.1.0",
          tailwindcss: "^4.1.0",
          "tw-animate-css": "^1.0.0",
        },
      },
      null,
      2
    ),
    "next.config.mjs": `/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  images: {
    formats: ["image/avif", "image/webp"],
    remotePatterns: [
      { protocol: "https", hostname: "images.unsplash.com" },
      { protocol: "https", hostname: "images.pexels.com" },
    ],
  },
};
export default nextConfig;
`,
    "postcss.config.mjs": `export default { plugins: { "@tailwindcss/postcss": {} } };
`,
    "jsconfig.json": JSON.stringify(
      { compilerOptions: { baseUrl: ".", paths: { "@/*": ["./*"] } } },
      null,
      2
    ),
    "app/layout.jsx": `import { Inter } from "next/font/google";
import "./globals.css";
import { siteData } from "@/lib/site-data";
import { SiteHeader } from "@/components/sections/site-header";
import { SiteFooter } from "@/components/sections/site-shell";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

export const metadata = {
  metadataBase: new URL(siteData.url),
  title: {
    default: siteData.name + " — " + siteData.tagline,
    template: "%s | " + siteData.name,
  },
  description: siteData.description,
  keywords: siteData.keywords,
  openGraph: {
    type: "website",
    url: siteData.url,
    siteName: siteData.name,
    title: siteData.name + " — " + siteData.tagline,
    description: siteData.description,
  },
  twitter: {
    card: "summary_large_image",
    title: siteData.name + " — " + siteData.tagline,
    description: siteData.description,
  },
  robots: { index: true, follow: true },
};

export default function RootLayout({ children }) {
  const themeStyle = {
    "--primary": siteData.theme.primary,
    "--primary-foreground": siteData.theme.primaryForeground,
    "--ring": siteData.theme.primary,
    "--radius": siteData.theme.radius,
  };
  return (
    <html lang="en">
      <body className={inter.variable + " antialiased"} style={themeStyle}>
        <a
          href="#content"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[100] focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground"
        >
          Skip to content
        </a>
        <SiteHeader />
        <main id="content">{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}`,
    "app/globals.css": `@import "tailwindcss";
@import "tw-animate-css";

@custom-variant dark (&:is(.dark *));

:root {
  --radius: 0.625rem;
  --background: oklch(1 0 0);
  --foreground: oklch(0.145 0 0);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.145 0 0);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.145 0 0);
  --primary: oklch(0.205 0 0);
  --primary-foreground: oklch(0.985 0 0);
  --secondary: oklch(0.97 0 0);
  --secondary-foreground: oklch(0.205 0 0);
  --muted: oklch(0.97 0 0);
  --muted-foreground: oklch(0.556 0 0);
  --accent: oklch(0.97 0 0);
  --accent-foreground: oklch(0.205 0 0);
  --destructive: oklch(0.577 0.245 27.325);
  --border: oklch(0.922 0 0);
  --input: oklch(0.922 0 0);
  --ring: oklch(0.708 0 0);
}

.dark {
  --background: oklch(0.145 0 0);
  --foreground: oklch(0.985 0 0);
  --card: oklch(0.205 0 0);
  --card-foreground: oklch(0.985 0 0);
  --popover: oklch(0.205 0 0);
  --popover-foreground: oklch(0.985 0 0);
  --primary: oklch(0.922 0 0);
  --primary-foreground: oklch(0.205 0 0);
  --secondary: oklch(0.269 0 0);
  --secondary-foreground: oklch(0.985 0 0);
  --muted: oklch(0.269 0 0);
  --muted-foreground: oklch(0.708 0 0);
  --accent: oklch(0.269 0 0);
  --accent-foreground: oklch(0.985 0 0);
  --destructive: oklch(0.704 0.191 22.216);
  --border: oklch(1 0 0 / 10%);
  --input: oklch(1 0 0 / 15%);
  --ring: oklch(0.556 0 0);
}

@theme inline {
  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) + 4px);
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --animate-accordion-down: accordion-down 0.2s ease-out;
  --animate-accordion-up: accordion-up 0.2s ease-out;
  @keyframes accordion-down {
    from { height: 0; }
    to { height: var(--radix-accordion-content-height); }
  }
  @keyframes accordion-up {
    from { height: var(--radix-accordion-content-height); }
    to { height: 0; }
  }
}

@layer base {
  * {
    @apply border-border;
  }
  body {
    @apply bg-background text-foreground;
    font-family: var(--font-inter), ui-sans-serif, system-ui, sans-serif;
  }
  html {
    scroll-behavior: smooth;
    scroll-padding-top: 5.5rem;
  }
  ::selection {
    background: var(--primary);
    color: var(--primary-foreground);
  }
  @media (prefers-reduced-motion: reduce) {
    html {
      scroll-behavior: auto;
    }
    *,
    *::before,
    *::after {
      animation-duration: 0.01ms !important;
      transition-duration: 0.01ms !important;
    }
  }
}
`,
    "app/page.jsx": `import { Compass, PenTool, Rocket, SearchCheck } from "lucide-react";
import {
  CtaSection,
  FaqSection,
  FeatureGrid,
  HeroSection,
  StatsSection,
  StepsSection,
} from "@/components/sections/marketing";
import { ContactSection } from "@/components/sections/contact";
import { siteData } from "@/lib/site-data";

const features = [
  {
    icon: Compass,
    title: "Strategy before pixels",
    text: "Every page starts from the visitor's goal: one clear offer, one primary action, no filler sections.",
  },
  {
    icon: PenTool,
    title: "A real design system",
    text: "Pages are composed from a preinstalled component and section library — consistent spacing, type and states everywhere.",
  },
  {
    icon: SearchCheck,
    title: "SEO and accessibility built in",
    text: "Semantic landmarks, one h1 per page, meta and Open Graph data, sitemap and robots — handled by the scaffold.",
  },
  {
    icon: Rocket,
    title: "Verified before it ships",
    text: "The agent builds the production bundle, audits the result and fixes issues before showing you a preview.",
  },
];

const steps = [
  { title: "Brief", text: "Audience, offer and the one action the page must drive — captured in the site data file." },
  { title: "Build", text: "Content-led sections composed from the library, with real copy written for this business." },
  { title: "Verify", text: "Production build, automated quality audit, visual check — then a shareable preview link." },
];

const faqs = [
  {
    q: "How do I change this site?",
    a: "Ask the agent in chat. It edits the site data, pages and components, rebuilds, audits and sends a fresh preview.",
  },
  {
    q: "Does the contact form really work?",
    a: "Yes — submissions are stored in the site owner's inbox in the agent, ready to read or summarize.",
  },
  {
    q: "Can it match my brand?",
    a: "Yes. The brand color, radius, name, tagline, navigation and contact details all live in lib/site-data.js.",
  },
];

export default function HomePage() {
  return (
    <>
      <HeroSection
        eyebrow="New website"
        title={siteData.name}
        description={siteData.tagline + ". This starter is composed from the senior section library — ask the agent to replace it with real pages for your business."}
        primaryCta={siteData.primaryCta}
        secondaryCta={{ label: "See how it works", href: "/#process" }}
      />
      <div id="services">
        <FeatureGrid
          eyebrow="Why it is built this way"
          title="Senior habits, baked into the scaffold"
          description="Not a blank canvas — an opinionated starting point that already handles the things junior sites forget."
          features={features}
        />
      </div>
      <StatsSection
        stats={[
          { value: "1", label: "Primary action per page", detail: "Every section earns its place" },
          { value: "100%", label: "Component-library UI", detail: "No hand-rolled buttons or inputs" },
          { value: "0", label: "Lorem ipsum", detail: "Real copy from the first draft" },
        ]}
      />
      <div id="process">
        <StepsSection
          eyebrow="Process"
          title="From brief to preview in three steps"
          description="The same workflow on every site, so quality does not depend on luck."
          steps={steps}
        />
      </div>
      <div id="faq">
        <FaqSection eyebrow="FAQ" title="Questions" faqs={faqs} />
      </div>
      <CtaSection
        title="Ready when you are"
        description="Tell the agent what this site should sell, book or explain — it will rebuild this starter into the real thing."
        cta={siteData.primaryCta}
      />
      <ContactSection />
    </>
  );
}`,
    "app/robots.js": `import { siteData } from "@/lib/site-data";

export default function robots() {
  return {
    rules: { userAgent: "*", allow: "/" },
    sitemap: siteData.url + "/sitemap.xml",
  };
}`,
    "app/sitemap.js": `import { siteData } from "@/lib/site-data";

export default function sitemap() {
  const now = new Date();
  return (siteData.sitemapRoutes || ["/"]).map((route, i) => ({
    url: siteData.url + (route === "/" ? "" : route),
    lastModified: now,
    changeFrequency: i === 0 ? "weekly" : "monthly",
    priority: i === 0 ? 1 : 0.7,
  }));
}`,
    "lib/site-data.js": siteDataFile(name, slug),
    "README.md": `# ${name}\n\nFrontend-only Next.js site generated by Riyan Agent. UI: shadcn/ui components (@/components/ui) + Lucide icons (lucide-react), preinstalled — compose them, don't hand-roll. Deploys to Vercel; production lives at https://${slug}.${SITE_APEX}.\n`,
  };
  return { ...base, ...UI_COMPONENT_FILES, ...SECTION_FILES, ...backendFiles(slug) };
}

export async function createSite(
  name: string,
  slugWanted?: string
): Promise<{ site: SiteRow; fileCount: number }> {
  const cleanName = name.trim().slice(0, 80);
  if (!cleanName) throw new Error("Site name is required");
  const slug = (slugWanted ? slugify(slugWanted) : slugify(cleanName)) || "";
  const slugError = validateSlug(slug);
  if (slugError) throw new Error(slugError);

  const sb = getServiceClient();
  const { data, error } = await sb
    .from("sites")
    .insert({ name: cleanName, slug, status: "draft" })
    .select("*")
    .single();
  if (error || !data) {
    if ((error as any)?.code === "23505") {
      throw new Error(`Subdomain "${slug}.${SITE_APEX}" is already taken — pick another slug.`);
    }
    throw new Error("Could not create site");
  }
  const site = data as SiteRow;
  const files = scaffoldFiles(cleanName, slug);
  const rows = Object.entries(files).map(([path, content]) => ({
    site_id: site.id,
    path,
    content,
  }));
  const ins = await sb.from("site_files").insert(rows);
  if (ins.error) {
    await sb.from("sites").delete().eq("id", site.id);
    throw new Error("Could not seed site files");
  }
  return { site, fileCount: rows.length };
}

export async function listSites(): Promise<SiteRow[]> {
  const { data } = await getServiceClient()
    .from("sites")
    .select("*")
    .order("updated_at", { ascending: false });
  return (data as SiteRow[]) ?? [];
}

export async function resolveSite(idOrSlug: string): Promise<SiteRow | null> {
  const sb = getServiceClient();
  const byId = await sb.from("sites").select("*").eq("id", idOrSlug).maybeSingle();
  if (byId.data) return byId.data as SiteRow;
  const bySlug = await sb.from("sites").select("*").eq("slug", idOrSlug).maybeSingle();
  return (bySlug.data as SiteRow) ?? null;
}

export async function listSiteFiles(
  siteId: string
): Promise<{ path: string; size: number; updated_at: string }[]> {
  const { data } = await getServiceClient()
    .from("site_files")
    .select("path, content, updated_at")
    .eq("site_id", siteId)
    .order("path");
  return (data ?? []).map((r: any) => ({
    path: r.path as string,
    size: (r.content as string).length,
    updated_at: r.updated_at as string,
  }));
}

export async function readSiteFile(siteId: string, path: string): Promise<string | null> {
  const { data } = await getServiceClient()
    .from("site_files")
    .select("content")
    .eq("site_id", siteId)
    .eq("path", path)
    .maybeSingle();
  return (data as any)?.content ?? null;
}

const ALLOWED_PREFIXES = ["app/", "components/", "lib/", "public/"];
const ALLOWED_EXTS = [".jsx", ".js", ".css", ".svg", ".json", ".md"];
const SCAFFOLD_OWNED = new Set([
  "package.json",
  "next.config.mjs",
  "postcss.config.mjs",
  "jsconfig.json",
  "app/layout.jsx",
  "app/globals.css",
  "lib/utils.js",
  "lib/site-config.js",
  "app/robots.js",
  "app/sitemap.js",
]);

export function validateSitePath(path: string): string | null {
  if (!path || path.includes("..") || path.startsWith("/") || path.includes("\\")) {
    return "Invalid path.";
  }
  if (SCAFFOLD_OWNED.has(path) || path.startsWith("components/ui/") || path.startsWith("components/site/") || path.startsWith("components/sections/")) {
    return `"${path}" is managed by the scaffold/component library and cannot be overwritten. Import it instead (library: "@/components/ui/…", backend form: "@/components/site/lead-form"); put your own components in components/ and pages in app/.`;
  }
  if (path === "README.md") return null;
  if (!ALLOWED_PREFIXES.some((p) => path.startsWith(p))) {
    return "Files must live under app/, components/, lib/ or public/.";
  }
  if (!ALLOWED_EXTS.some((e) => path.endsWith(e))) {
    return `Unsupported file type. Allowed: ${ALLOWED_EXTS.join(", ")}.`;
  }
  return null;
}

export async function writeSiteFile(
  siteId: string,
  path: string,
  content: string
): Promise<{ path: string; size: number }> {
  const pathError = validateSitePath(path);
  if (pathError) throw new Error(pathError);
  if (content.length > MAX_FILE_CHARS) throw new Error("File is too large (200KB max).");
  const sb = getServiceClient();
  const existing = await readSiteFile(siteId, path);
  if (existing === null) {
    const { count } = await sb
      .from("site_files")
      .select("id", { count: "exact", head: true })
      .eq("site_id", siteId);
    if ((count ?? 0) >= MAX_FILES) throw new Error(`Site already has the maximum of ${MAX_FILES} files.`);
  }
  const { error } = await sb
    .from("site_files")
    .upsert(
      { site_id: siteId, path, content, updated_at: new Date().toISOString() },
      { onConflict: "site_id,path" }
    );
  if (error) throw new Error("Could not save file");
  await sb
    .from("sites")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", siteId);
  return { path, size: content.length };
}

/**
 * Force-sync every scaffold-owned file (configs, layout, theme, component
 * library) to the latest version. Runs at deploy time so sites created
 * before a scaffold upgrade (e.g. the component library) pick it up
 * automatically. Never touches the site's pages or custom components —
 * app/page.jsx is seeded at creation only.
 */
export async function syncScaffoldFiles(site: SiteRow): Promise<void> {
  const all = scaffoldFiles(site.name, site.slug);
  const sb = getServiceClient();
  const rows = Object.entries(all)
    .filter(([path]) => path !== "app/page.jsx" && path !== "README.md" && path !== "lib/site-data.js")
    .map(([path, content]) => ({
      site_id: site.id,
      path,
      content,
      updated_at: new Date().toISOString(),
    }));
  if (rows.length) {
    await sb.from("site_files").upsert(rows, { onConflict: "site_id,path" });
  }
}

export async function getAllFiles(siteId: string): Promise<{ path: string; content: string }[]> {
  const { data } = await getServiceClient()
    .from("site_files")
    .select("path, content")
    .eq("site_id", siteId);
  return (data as { path: string; content: string }[]) ?? [];
}

type SitePatch = {
  name?: string;
  slug?: string;
  vercel_project_id?: string | null;
  preview_url?: string | null;
  live_url?: string | null;
  status?: string;
};

async function updateSite(id: string, patch: SitePatch): Promise<void> {
  await getServiceClient()
    .from("sites")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id);
}

// ---------------------------------------------------------------------------
// Deploy pipeline (Vercel REST + Cloudflare DNS)
// ---------------------------------------------------------------------------

function sha1Hex(content: string): string {
  return createHash("sha1").update(Buffer.from(content, "utf8")).digest("hex");
}

async function vercelFetch(
  token: string,
  teamId: string | undefined,
  path: string,
  init?: RequestInit
): Promise<{ res: Response; data: any }> {
  const sep = path.includes("?") ? "&" : "?";
  const url = `https://api.vercel.com${path}${teamId ? `${sep}teamId=${teamId}` : ""}`;
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init?.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

function vercelError(data: any, fallback: string): string {
  return data?.error?.message || data?.error?.code || fallback;
}

async function ensureVercelProject(
  token: string,
  teamId: string | undefined,
  site: SiteRow
): Promise<string> {
  if (site.vercel_project_id) return site.vercel_project_id;
  const got = await vercelFetch(token, teamId, `/v9/projects/${site.slug}`);
  if (got.res.ok && got.data?.id) {
    await updateSite(site.id, { vercel_project_id: got.data.id });
    return got.data.id as string;
  }
  const created = await vercelFetch(token, teamId, `/v11/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: site.slug, framework: "nextjs" }),
  });
  if (!created.res.ok || !created.data?.id) {
    throw new Error(`Vercel project creation failed: ${vercelError(created.data, created.res.status.toString())}`);
  }
  await updateSite(site.id, { vercel_project_id: created.data.id });
  return created.data.id as string;
}

async function cfFetch(
  token: string,
  path: string,
  init?: RequestInit
): Promise<{ res: Response; data: any }> {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

async function cfUpsertRecord(
  token: string,
  zoneId: string,
  type: string,
  name: string,
  content: string
): Promise<void> {
  const listed = await cfFetch(
    token,
    `/zones/${zoneId}/dns_records?type=${type}&name=${encodeURIComponent(name)}`
  );
  const existing = listed.data?.result?.[0];
  const body = JSON.stringify({ type, name, content, ttl: 300, proxied: false });
  if (existing) {
    if (existing.content === content && existing.proxied === false) return;
    const upd = await cfFetch(token, `/zones/${zoneId}/dns_records/${existing.id}`, {
      method: "PUT",
      body,
    });
    if (!upd.res.ok) throw new Error(`Cloudflare DNS update failed: ${upd.data?.errors?.[0]?.message || upd.res.status}`);
  } else {
    const created = await cfFetch(token, `/zones/${zoneId}/dns_records`, { method: "POST", body });
    if (!created.res.ok) {
      throw new Error(`Cloudflare DNS create failed: ${created.data?.errors?.[0]?.message || created.res.status}`);
    }
  }
}

/** Attach <slug>.veritask.site on Vercel + create/refresh its Cloudflare DNS. */
async function attachDomain(
  token: string,
  teamId: string | undefined,
  cfToken: string,
  projectId: string,
  slug: string
): Promise<{ fqdn: string; verified: boolean; note?: string }> {
  const fqdn = `${slug}.${SITE_APEX}`;
  const added = await vercelFetch(token, teamId, `/v10/projects/${projectId}/domains`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: fqdn }),
  });
  // 409/already-exists is fine — fall through to verification handling
  if (!added.res.ok && added.res.status !== 409) {
    throw new Error(`Vercel domain attach failed: ${vercelError(added.data, added.res.status.toString())}`);
  }
  const verification: { type: string; domain: string; value: string }[] =
    added.data?.verification || [];

  const zone = await cfFetch(cfToken, `/zones?name=${SITE_APEX}`);
  const zoneId = zone.data?.result?.[0]?.id;
  if (!zoneId) throw new Error(`Cloudflare zone ${SITE_APEX} not found for this token`);

  for (const v of verification) {
    if (v.type === "TXT") await cfUpsertRecord(cfToken, zoneId, "TXT", v.domain, v.value);
  }
  await cfUpsertRecord(cfToken, zoneId, "CNAME", fqdn, "cname.vercel-dns.com");

  const check = await vercelFetch(token, teamId, `/v9/projects/${projectId}/domains/${fqdn}`);
  const verified = check.res.ok ? !!check.data?.verified : false;
  return {
    fqdn,
    verified,
    note: verified
      ? undefined
      : "DNS is set; Vercel may take a few minutes to verify the domain and issue its certificate.",
  };
}

export interface DeployResult {
  ok: boolean;
  target: "preview" | "production";
  state?: string;
  previewUrl?: string;
  liveUrl?: string;
  domainVerified?: boolean;
  note?: string;
  error?: string;
}

export async function deploySite(
  idOrSlug: string,
  target: "preview" | "production"
): Promise<DeployResult> {
  const cfg = await getHostingConfig();
  if (!cfg.vercelToken) {
    return {
      ok: false,
      target,
      error:
        "Vercel is not configured. Add a Vercel API token in Settings → Website builder, then deploy again.",
    };
  }
  const site = await resolveSite(idOrSlug);
  if (!site) return { ok: false, target, error: "Site not found" };
  await syncScaffoldFiles(site);
  const files = await getAllFiles(site.id);
  if (!files.length) return { ok: false, target, error: "Site has no files" };
  const token = cfg.vercelToken;
  const teamId = cfg.vercelTeamId;

  const projectId = await ensureVercelProject(token, teamId, site);

  // Upload every file blob (Vercel dedupes by digest)
  const manifest: { file: string; sha: string; size: number }[] = [];
  for (let i = 0; i < files.length; i += 8) {
    const chunk = files.slice(i, i + 8);
    await Promise.all(
      chunk.map(async (f) => {
        const bytes = Buffer.from(f.content, "utf8");
        const sha = sha1Hex(f.content);
        manifest.push({ file: f.path, sha, size: bytes.length });
        const up = await fetch(
          `https://api.vercel.com/v2/files${teamId ? `?teamId=${teamId}` : ""}`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "x-vercel-digest": sha,
              "Content-Type": "application/octet-stream",
            },
            body: bytes,
          }
        );
        if (!up.ok) {
          const d = await up.json().catch(() => ({}));
          throw new Error(`Vercel file upload failed for ${f.path}: ${vercelError(d, up.status.toString())}`);
        }
      })
    );
  }

  const dep = await vercelFetch(token, teamId, `/v13/deployments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: site.slug,
      project: projectId,
      files: manifest,
      target,
      projectSettings: { framework: "nextjs" },
    }),
  });
  if (!dep.res.ok || !dep.data?.id) {
    // Surface missing-files style errors verbatim-ish for debuggability
    return {
      ok: false,
      target,
      error: `Vercel deployment failed: ${vercelError(dep.data, dep.res.status.toString())}`,
    };
  }

  // Poll until READY (max ~4.5 min) — builds of small sites take ~1 min
  let state: string = dep.data.readyState || "QUEUED";
  let url: string | undefined = dep.data.url;
  const deadline = Date.now() + 270_000;
  while (state !== "READY" && state !== "ERROR" && state !== "CANCELED" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    const poll = await vercelFetch(token, teamId, `/v13/deployments/${dep.data.id}`);
    if (poll.res.ok) {
      state = poll.data.readyState || state;
      url = poll.data.url || url;
    }
  }
  if (state !== "READY") {
    return {
      ok: false,
      target,
      state,
      previewUrl: url ? `https://${url}` : undefined,
      error:
        state === "ERROR" || state === "CANCELED"
          ? `Vercel build ${state.toLowerCase()} — check the deployment in the Vercel dashboard for build logs.`
          : "Build is still running after 4.5 minutes — call site_status or deploy again shortly to pick up the result.",
    };
  }

  const deploymentUrl = url ? `https://${url}` : undefined;
  if (target === "preview") {
    await updateSite(site.id, { preview_url: deploymentUrl ?? site.preview_url, status: "preview" });
    return { ok: true, target, state, previewUrl: deploymentUrl };
  }

  // Production: attach the subdomain
  if (!cfg.cloudflareToken) {
    await updateSite(site.id, { preview_url: deploymentUrl ?? site.preview_url, status: "preview" });
    return {
      ok: true,
      target,
      state,
      previewUrl: deploymentUrl,
      note: "Production build is READY, but the subdomain was not attached: add a Cloudflare API token (DNS edit on veritask.site) in Settings → Website builder, then deploy to production again.",
    };
  }
  const domain = await attachDomain(token, teamId, cfg.cloudflareToken, projectId, site.slug);
  const liveUrl = `https://${domain.fqdn}`;
  await updateSite(site.id, {
    live_url: liveUrl,
    preview_url: deploymentUrl ?? site.preview_url,
    status: "live",
  });
  return {
    ok: true,
    target,
    state,
    previewUrl: deploymentUrl,
    liveUrl,
    domainVerified: domain.verified,
    note: domain.note,
  };
}

/** Delete a site everywhere: Vercel project + Cloudflare DNS (best effort), then DB rows. */
export async function deleteSiteCompletely(idOrSlug: string): Promise<{ ok: boolean; error?: string }> {
  const site = await resolveSite(idOrSlug);
  if (!site) return { ok: false, error: "Site not found" };
  const cfg = await getHostingConfig();
  if (cfg.vercelToken && site.vercel_project_id) {
    await vercelFetch(cfg.vercelToken, cfg.vercelTeamId, `/v11/projects/${site.vercel_project_id}`, {
      method: "DELETE",
    }).catch(() => {});
  }
  if (cfg.cloudflareToken) {
    try {
      const zone = await cfFetch(cfg.cloudflareToken, `/zones?name=${SITE_APEX}`);
      const zoneId = zone.data?.result?.[0]?.id;
      if (zoneId) {
        const fqdn = `${site.slug}.${SITE_APEX}`;
        for (const type of ["CNAME", "TXT"]) {
          const name = type === "TXT" ? `_vercel.${fqdn}` : fqdn;
          const listed = await cfFetch(
            cfg.cloudflareToken,
            `/zones/${zoneId}/dns_records?type=${type}&name=${encodeURIComponent(name)}`
          );
          for (const rec of listed.data?.result ?? []) {
            await cfFetch(cfg.cloudflareToken, `/zones/${zoneId}/dns_records/${rec.id}`, {
              method: "DELETE",
            }).catch(() => {});
          }
        }
      }
    } catch {
      /* DNS cleanup is best-effort */
    }
  }
  const { error } = await getServiceClient().from("sites").delete().eq("id", site.id);
  if (error) return { ok: false, error: "Database error deleting site" };
  return { ok: true };
}
