import { CheerioAPI, load as parseHTML } from 'cheerio';
import { fetchApi } from '@libs/fetch';
import { FilterTypes, Filters } from '@libs/filterInputs';
import { Plugin } from '@/types/plugin';
import dayjs from 'dayjs';

class ScribbleHubPlugin implements Plugin.PluginBase {
  id = 'scribblehub';
  name = 'Scribble Hub';
  icon = 'src/en/scribblehub/icon.png';
  site = 'https://www.scribblehub.com/';
  version = '1.0.3';

  parseNovels(loadedCheerio: CheerioAPI) {
    const novels: Plugin.NovelItem[] = [];

    loadedCheerio('.search_main_box').each((i, el) => {
      const novelName = loadedCheerio(el).find('.search_title > a').text();
      const novelCover = loadedCheerio(el).find('.search_img img').attr('src');
      const novelUrl = loadedCheerio(el).find('.search_title > a').attr('href');

      if (!novelUrl) return;

      const novel = {
        name: novelName,
        cover: novelCover,
        path: novelUrl.replace(this.site, ''),
      };
      novels.push(novel);
    });
    return novels;
  }

  async popularNovels(
    page: number,
    {
      showLatestNovels,
      filters,
    }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    let url = `${this.site}`;
    if (showLatestNovels) {
      url += `latest-series/?pg=${page}`;
    } else if (filters) {
      const params = new URLSearchParams();
      if (filters.genres.value.include?.length) {
        params.append('gi', filters.genres.value.include.join(','));
      }
      if (
        filters.genres.value.include?.length ||
        filters.genres.value.exclude?.length
      ) {
        params.append('mgi', filters.genre_operator.value);
      }
      if (filters.genres.value.exclude?.length) {
        params.append('ge', filters.genres.value.exclude.join(','));
      }
      if (filters.content_warning.value.include?.length) {
        params.append('cti', filters.content_warning.value.include.join(','));
      }
      if (
        filters.content_warning.value.include?.length ||
        filters.content_warning.value.exclude?.length
      ) {
        params.append('mct', filters.content_warning_operator.value);
      }
      if (filters.content_warning.value.exclude?.length) {
        params.append('cte', filters.content_warning.value.exclude.join(','));
      }
      params.append('cp', filters.storyStatus.value);
      params.append('sort', filters.sort.value);
      params.append('order', filters.order.value);
      params.append('pg', page.toString());
      url += `series-finder/?sf=1&${params.toString()}`;
    } else {
      url += `series-finder/?sf=1&sort=ratings&order=desc&pg=${page}`;
    }

    const body = await fetchApi(url).then(result => result.text());

    const loadedCheerio = parseHTML(body);
    return this.parseNovels(loadedCheerio);
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const result = await fetchApi(this.site + novelPath);
    const body = await result.text();

    let loadedCheerio = parseHTML(body);

    const novel: Plugin.SourceNovel = {
      path: novelPath,
      name: loadedCheerio('.fic_title').text() || 'Untitled',
      cover: loadedCheerio('.fic_image > img').attr('src'),
      summary: loadedCheerio('.wi_fic_desc').text(),
      author: loadedCheerio('.auth_name_fic').text(),
      chapters: [],
    };

    novel.genres = loadedCheerio('.fic_genre')
      .map((i, el) => loadedCheerio(el).text())
      .toArray()
      .join(',');

    novel.status = loadedCheerio('.rnd_stats').next().text().includes('Ongoing')
      ? 'Ongoing'
      : 'Completed';

    const data = await fetchApi(`${this.site}wp-admin/admin-ajax.php`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        // The site's firewall rejects AJAX requests without a matching Origin
        Origin: this.site.replace(/\/$/, ''),
        Referer: this.site + novelPath,
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: `action=wi_getreleases_pagination&pagenum=-1&mypostid=${novelPath.split('/')[1]}`,
    });
    const text = await data.text();

    loadedCheerio = parseHTML(text);

    const chapter: Plugin.ChapterItem[] = [];

    const units = {
      sec: 'second',
      min: 'minute',
      hour: 'hour',
      day: 'day',
      week: 'week',
      month: 'month',
      year: 'year',
    } as const;
    const months = [
      'jan',
      'feb',
      'mar',
      'apr',
      'may',
      'jun',
      'jul',
      'aug',
      'sep',
      'oct',
      'nov',
      'dec',
    ];

    const parseISODate = (date: string) => {
      // Relative dates, e.g. "17 hours ago", "1 min ago"
      const relative = date.match(
        /(\d+)\s*(sec|min|hour|day|week|month|year)/i,
      );
      if (relative && date.includes('ago')) {
        const unit = units[relative[2].toLowerCase() as keyof typeof units];
        return dayjs().subtract(parseInt(relative[1], 10), unit).toISOString();
      }

      // Absolute dates, e.g. "Mar 31, 2022 07:32 PM" or "Mar 31, 2022"
      const absolute = date.match(
        /([a-z]{3})[a-z]*\s+(\d{1,2}),\s*(\d{4})(?:\s+(\d{1,2}):(\d{2})\s*([ap]m))?/i,
      );
      if (absolute) {
        const month = months.indexOf(absolute[1].toLowerCase());
        if (month === -1) return null;
        let hour = absolute[4] ? parseInt(absolute[4], 10) % 12 : 0;
        if (absolute[6]?.toLowerCase() === 'pm') hour += 12;
        return dayjs(
          new Date(
            parseInt(absolute[3], 10),
            month,
            parseInt(absolute[2], 10),
            hour,
            absolute[5] ? parseInt(absolute[5], 10) : 0,
          ),
        ).toISOString();
      }
      return null;
    };

    loadedCheerio('.toc_w').each((i, el) => {
      const chapterName = loadedCheerio(el).find('.toc_a').text();
      const dateEl = loadedCheerio(el).find('.fic_date_pub');
      // The title attribute contains the full timestamp
      const releaseDate = dateEl.attr('title') || dateEl.text();
      const chapterUrl = loadedCheerio(el).find('a').attr('href');

      if (!chapterUrl) return;
      chapter.push({
        name: chapterName,
        releaseTime: parseISODate(releaseDate),
        path: chapterUrl.replace(this.site, ''),
      });
    });

    novel.chapters = chapter.reverse();

    return novel;
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const result = await fetchApi(this.site + chapterPath);
    const body = await result.text();

    const loadedCheerio = parseHTML(body);

    const chapterText = loadedCheerio('div.chp_raw').html() || '';
    return chapterText;
  }

  async searchNovels(
    searchTerm: string,
    page: number,
  ): Promise<Plugin.NovelItem[]> {
    const url = `${this.site}series-finder/?sf=1&sh=${encodeURIComponent(searchTerm)}&pg=${page}`;
    const result = await fetchApi(url);
    const body = await result.text();

    const loadedCheerio = parseHTML(body);
    return this.parseNovels(loadedCheerio);
  }

  filters = {
    sort: {
      label: 'Sort Results By',
      value: 'ratings',
      options: [
        { label: 'Chapters', value: 'chapters' },
        { label: 'Chapters per Week', value: 'frequency' },
        { label: 'Date Added', value: 'dateadded' },
        { label: 'Favorites', value: 'favorites' },
        { label: 'Last Updated', value: 'lastchdate' },
        { label: 'Number of Ratings', value: 'numofrate' },
        { label: 'Pages', value: 'pages' },
        { label: 'Pageviews', value: 'pageviews' },
        { label: 'Ratings', value: 'ratings' },
        { label: 'Readers', value: 'readers' },
        { label: 'Reviews', value: 'reviews' },
        { label: 'Total Words', value: 'totalwords' },
      ],
      type: FilterTypes.Picker,
    },
    order: {
      label: 'Order By',
      value: 'desc',
      options: [
        { label: 'Descending', value: 'desc' },
        { label: 'Ascending', value: 'asc' },
      ],
      type: FilterTypes.Picker,
    },
    storyStatus: {
      label: 'Story Status',
      value: 'all',
      options: [
        { label: 'All', value: 'all' },
        { label: 'Completed', value: 'completed' },
        { label: 'Ongoing', value: 'ongoing' },
        { label: 'Hiatus', value: 'hiatus' },
      ],
      type: FilterTypes.Picker,
    },
    genre_operator: {
      value: 'and',
      label: 'Genres (And/Or)',
      options: [
        { label: 'And', value: 'and' },
        { label: 'Or', value: 'or' },
      ],
      type: FilterTypes.Picker,
    },
    genres: {
      label: 'Genres',
      value: {
        include: [],
        exclude: [],
      },
      options: [
        { label: 'Action', value: '9' },
        { label: 'Adult', value: '902' },
        { label: 'Adventure', value: '8' },
        { label: 'Boys Love', value: '891' },
        { label: 'Comedy', value: '7' },
        { label: 'Drama', value: '903' },
        { label: 'Ecchi', value: '904' },
        { label: 'Fanfiction', value: '38' },
        { label: 'Fantasy', value: '19' },
        { label: 'Gender Bender', value: '905' },
        { label: 'Girls Love', value: '892' },
        { label: 'Harem', value: '1015' },
        { label: 'Historical', value: '21' },
        { label: 'Horror', value: '22' },
        { label: 'Isekai', value: '37' },
        { label: 'Josei', value: '906' },
        { label: 'LitRPG', value: '1180' },
        { label: 'Martial Arts', value: '907' },
        { label: 'Mature', value: '20' },
        { label: 'Mecha', value: '908' },
        { label: 'Mystery', value: '909' },
        { label: 'Psychological', value: '910' },
        { label: 'Romance', value: '6' },
        { label: 'School Life', value: '911' },
        { label: 'Sci-fi', value: '912' },
        { label: 'Seinen', value: '913' },
        { label: 'Slice of Life', value: '914' },
        { label: 'Smut', value: '915' },
        { label: 'Sports', value: '916' },
        { label: 'Supernatural', value: '5' },
        { label: 'Tragedy', value: '901' },
      ],
      type: FilterTypes.ExcludableCheckboxGroup,
    },
    content_warning_operator: {
      value: 'and',
      label: 'Mature Content (And/Or)',
      options: [
        { label: 'And', value: 'and' },
        { label: 'Or', value: 'or' },
      ],
      type: FilterTypes.Picker,
    },
    content_warning: {
      value: {
        include: [],
        exclude: [],
      },
      label: 'Mature Content',
      options: [
        { label: 'Gore', value: '48' },
        { label: 'Sexual Content', value: '50' },
        { label: 'Strong Language', value: '49' },
      ],
      type: FilterTypes.ExcludableCheckboxGroup,
    },
  } satisfies Filters;
}

export default new ScribbleHubPlugin();
