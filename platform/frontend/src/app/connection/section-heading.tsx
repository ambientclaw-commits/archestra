interface SectionHeadingProps {
  step: number;
  title: string;
}

export function SectionHeading({ step, title }: SectionHeadingProps) {
  return (
    <h2 className="mt-3 pl-1 text-2xl font-bold tracking-tight text-foreground sm:text-[26px]">
      <span className="mr-2 text-muted-foreground/70">Step {step}:</span>
      {title}
    </h2>
  );
}
