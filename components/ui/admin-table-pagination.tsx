import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "./pagination";

interface AdminTablePaginationProps {
  page: number;
  totalPages: number;
  /** Search param name this table paginates on, e.g. "usersPage". */
  param: string;
  filters?: Record<string, string>;
}

function hrefForPage(
  param: string,
  page: number,
  filters: Record<string, string>
): string {
  return `?${new URLSearchParams({ ...filters, [param]: String(page) })}`;
}

export default function AdminTablePagination({
  page,
  totalPages,
  param,
  filters = {},
}: AdminTablePaginationProps): React.JSX.Element {
  const atStart = page <= 1;
  const atEnd = page >= totalPages;

  return (
    <Pagination>
      <PaginationContent>
        <PaginationItem>
          <PaginationPrevious
            href={hrefForPage(param, Math.max(1, page - 1), filters)}
            aria-disabled={atStart}
            className={atStart ? "pointer-events-none opacity-50" : undefined}
          />
        </PaginationItem>
        <PaginationItem>
          <PaginationLink href={hrefForPage(param, page, filters)} isActive>
            {page} / {totalPages}
          </PaginationLink>
        </PaginationItem>
        <PaginationItem>
          <PaginationNext
            href={hrefForPage(param, Math.min(totalPages, page + 1), filters)}
            aria-disabled={atEnd}
            className={atEnd ? "pointer-events-none opacity-50" : undefined}
          />
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  );
}
