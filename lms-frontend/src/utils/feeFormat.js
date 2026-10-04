export const money = (n) => `Rs. ${Number(n || 0).toLocaleString("en-PK")}`;

export const fmtDate = (d) => {
  if (!d) return "—";
  const date = new Date(d);
  return Number.isNaN(date.getTime()) ? d : date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
};
