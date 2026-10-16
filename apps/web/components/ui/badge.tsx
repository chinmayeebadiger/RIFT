import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.08em]",
  {
    variants: {
      variant: {
        neutral: "border-slate-200 bg-slate-50 text-slate-500",
        danger: "border-[#ffd5d0] bg-[#fff1ef] text-[#c94c3f]",
        success: "border-[#bcecdf] bg-[#eafaf5] text-[#16866b]",
        warning: "border-[#f9dfaa] bg-[#fff8e8] text-[#a66a00]",
        blue: "border-[#cbdcff] bg-[#eff4ff] text-[#4469c5]",
      },
    },
    defaultVariants: { variant: "neutral" },
  },
);

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
