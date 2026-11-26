"""Find Hindi and Bengali songs in Spotify's catalog."""

import time

import requests


class SpotifyError(RuntimeError):
    """A Spotify request could not be completed."""


class SpotifyService:
    TOKEN_URL = "https://accounts.spotify.com/api/token"
    SEARCH_URL = "https://api.spotify.com/v1/search"
    LANGUAGES = ("Hindi", "English")
    TRACKS_PER_LANGUAGE = 10
    EMOTION_QUERIES = {
        "angry": "rock energetic",
        "disgust": "moody indie",
        "fear": "dark ambient",
        "happy": "happy",
        "neutral": "chill lofi",
        "sad": "sad",
        "surprise": "party dance",
    }

    def __init__(self, client_id, client_secret, market="IN"):
        self.client_id = client_id
        self.client_secret = client_secret
        self.market = market
        self.access_token = None
        self.token_expires_at = 0

    def _get_access_token(self):
        if self.access_token and time.time() < self.token_expires_at:
            return self.access_token

        if not self.client_id or not self.client_secret:
            raise SpotifyError(
                "Add SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET to your .env file."
            )

        try:
            response = requests.post(
                self.TOKEN_URL,
                data={"grant_type": "client_credentials"},
                auth=(self.client_id, self.client_secret),
                timeout=15,
            )
            if response.status_code >= 400:
                raise SpotifyError(
                    "Spotify could not authenticate these credentials. Check your .env values."
                )
            token_data = response.json()
        except SpotifyError:
            raise
        except (requests.RequestException, ValueError) as exc:
            raise SpotifyError("Spotify sign-in is temporarily unavailable.") from exc

        self.access_token = token_data.get("access_token")
        expires_in = token_data.get("expires_in", 3600)
        if not self.access_token:
            raise SpotifyError("Spotify did not return an access token.")

        # Refresh the token a little early so it does not expire during a search.
        self.token_expires_at = time.time() + int(expires_in) - 60
        return self.access_token

    def get_language_tracks(self, page=0, emotion=None):
        token = self._get_access_token()
        page = min(max(int(page), 0), 99)
        normalized_emotion = (emotion or "").strip().lower()
        mood_query = self.EMOTION_QUERIES.get(normalized_emotion, "")
        tracks = []
        seen_ids = set()

        for language in self.LANGUAGES:
            language_tracks = self._search_language(
                language, page * self.TRACKS_PER_LANGUAGE, token, mood_query
            )
            for track in language_tracks:
                if track["id"] not in seen_ids:
                    track["language"] = language
                    tracks.append(track)
                    seen_ids.add(track["id"])

        return tracks

    def _search_language(self, language, offset, token, mood_query=""):
        query = f"{language} {mood_query} song" if mood_query else f"{language} song"
        try:
            response = requests.get(
                self.SEARCH_URL,
                headers={"Authorization": f"Bearer {token}"},
                params={
                    "q": query,
                    "type": "track",
                    "market": self.market,
                    "limit": self.TRACKS_PER_LANGUAGE,
                    "offset": offset,
                },
                timeout=15,
            )
            if response.status_code == 429:
                raise SpotifyError("Spotify is limiting requests. Wait a moment and try again.")
            if response.status_code >= 400:
                raise SpotifyError(f"Spotify returned HTTP {response.status_code}.")
            tracks = response.json().get("tracks", {}).get("items", [])
        except SpotifyError:
            raise
        except (requests.RequestException, ValueError, TypeError, AttributeError) as exc:
            raise SpotifyError("Spotify search is temporarily unavailable.") from exc

        return [self._format_track(track) for track in tracks if isinstance(track, dict)]

    @staticmethod
    def _format_track(track):
        album = track.get("album") or {}
        artists = track.get("artists") or []
        images = album.get("images") or []
        links = track.get("external_urls") or {}

        return {
            "id": track.get("id", ""),
            "name": track.get("name") or "Unknown track",
            "artist": ", ".join(
                artist.get("name", "") for artist in artists if artist.get("name")
            ) or "Unknown artist",
            "album": album.get("name") or "Spotify track",
            "artwork": images[0].get("url") if images else None,
            "spotify_url": links.get("spotify"),
        }
