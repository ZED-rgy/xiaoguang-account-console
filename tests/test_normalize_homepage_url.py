# -*- coding: utf-8 -*-
"""normalize_homepage_url 回归测试：python -m unittest discover -s tests -t ."""
import unittest

from backend.main import normalize_homepage_url


class NormalizeHomepageUrlTest(unittest.TestCase):
    def test_douyin_share_text_extracts_short_link(self):
        share = (
            "7- 长按复制此条消息，打开抖音搜索，查看TA的更多作品。"
            " https://v.douyin.com/iAbCdEf 复制此链接"
        )
        self.assertEqual(normalize_homepage_url(share), "https://v.douyin.com/iAbCdEf/")

    def test_douyin_user_url_wins_over_short_link(self):
        text = (
            "主页 https://www.douyin.com/user/MS4wLjABAAAA-xyz_123"
            " 短链 https://v.douyin.com/abc/"
        )
        self.assertEqual(
            normalize_homepage_url(text),
            "https://www.douyin.com/user/MS4wLjABAAAA-xyz_123",
        )

    def test_douyin_user_url_keeps_dots_in_sec_uid(self):
        self.assertEqual(
            normalize_homepage_url(
                "https://www.douyin.com/user/MS4wLjABAAAA.abc_123-xyz?from_tab_name=main"
            ),
            "https://www.douyin.com/user/MS4wLjABAAAA.abc_123-xyz",
        )

    def test_douyin_short_link_gets_trailing_slash(self):
        self.assertEqual(
            normalize_homepage_url("https://v.douyin.com/iAbCdEf"),
            "https://v.douyin.com/iAbCdEf/",
        )

    def test_bilibili_space(self):
        self.assertEqual(
            normalize_homepage_url("空间 https://space.bilibili.com/12345678 求关注"),
            "https://space.bilibili.com/12345678",
        )

    def test_bilibili_space_subpage_is_canonicalized_to_account_root(self):
        self.assertEqual(
            normalize_homepage_url("https://space.bilibili.com/12345678/dynamic"),
            "https://space.bilibili.com/12345678",
        )

    def test_bilibili_short_link(self):
        self.assertEqual(
            normalize_homepage_url("https://b23.tv/AbCd12"),
            "https://b23.tv/AbCd12",
        )

    def test_kuaishou_profile(self):
        self.assertEqual(
            normalize_homepage_url("https://www.kuaishou.com/profile/3xabc-def_99，快来看"),
            "https://www.kuaishou.com/profile/3xabc-def_99",
        )

    def test_xiaohongshu_profile(self):
        self.assertEqual(
            normalize_homepage_url(
                "https://www.xiaohongshu.com/user/profile/5ff0a1b2c3d4e5f6a7b8c9d0"
            ),
            "https://www.xiaohongshu.com/user/profile/5ff0a1b2c3d4e5f6a7b8c9d0",
        )

    def test_generic_url_strips_trailing_punctuation(self):
        self.assertEqual(
            normalize_homepage_url("https://example.com/somebody/,"),
            "https://example.com/somebody",
        )

    def test_plain_text_and_empty_pass_through(self):
        self.assertEqual(normalize_homepage_url("还没有填主页"), "还没有填主页")
        self.assertIsNone(normalize_homepage_url(None))
        self.assertEqual(normalize_homepage_url(""), "")


if __name__ == "__main__":
    unittest.main()
