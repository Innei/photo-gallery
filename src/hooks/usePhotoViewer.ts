import { atom, useAtom, useAtomValue } from 'jotai'
import { useCallback, useEffect, useMemo } from 'react'
import { useLocation, useNavigate } from 'react-router'

import { gallerySettingAtom } from '~/atoms/app'
import { photoLoader } from '~/data/photos'

const openAtom = atom(false)
const currentIndexAtom = atom(0)
const triggerElementAtom = atom<HTMLElement | null>(null)
const data = photoLoader.getPhotos()
export const usePhotos = () => {
  const { sortOrder } = useAtomValue(gallerySettingAtom)

  const masonryItems = useMemo(() => {
    const sortedPhotos = [...data].sort((a, b) => {
      let aDateStr = ''
      let bDateStr = ''

      if (a.exif && a.exif.Photo && a.exif.Photo.DateTimeOriginal) {
        aDateStr = a.exif.Photo.DateTimeOriginal as unknown as string
      } else {
        aDateStr = a.lastModified
      }

      if (b.exif && b.exif.Photo && b.exif.Photo.DateTimeOriginal) {
        bDateStr = b.exif.Photo.DateTimeOriginal as unknown as string
      } else {
        bDateStr = b.lastModified
      }

      return sortOrder === 'asc'
        ? aDateStr.localeCompare(bDateStr)
        : bDateStr.localeCompare(aDateStr)
    })

    return sortedPhotos
  }, [sortOrder])
  return masonryItems
}
export const usePhotoViewer = () => {
  const photos = usePhotos()
  const [isOpen, setIsOpen] = useAtom(openAtom)
  const [currentIndex, setCurrentIndex] = useAtom(currentIndexAtom)
  const [triggerElement, setTriggerElement] = useAtom(triggerElementAtom)

  const navigate = useNavigate()

  const openViewer = useCallback(
    (index: number, element?: HTMLElement) => {
      setCurrentIndex(index)
      setTriggerElement(element || null)
      setIsOpen(true)
      // 防止背景滚动
      document.body.style.overflow = 'hidden'
    },
    [setCurrentIndex, setIsOpen, setTriggerElement],
  )

  const closeViewer = useCallback(() => {
    setIsOpen(false)
    setTriggerElement(null)
    // 恢复背景滚动
    document.body.style.overflow = ''
  }, [setIsOpen, setTriggerElement])

  const goToNext = useCallback(() => {
    if (currentIndex < photos.length - 1) {
      setCurrentIndex(currentIndex + 1)
    }
  }, [currentIndex, photos.length, setCurrentIndex])

  const location = useLocation()
  useEffect(() => {
    if (!isOpen) {
      const timer = setTimeout(() => {
        navigate('/')
      }, 500)
      return () => clearTimeout(timer)
    }
    const targetPathname = `/${photos[currentIndex].id}`
    if (location.pathname !== targetPathname) {
      navigate(targetPathname)
    }
  }, [currentIndex, isOpen, location.pathname, navigate, photos])

  const goToPrevious = useCallback(() => {
    if (currentIndex > 0) {
      setCurrentIndex(currentIndex - 1)
    }
  }, [currentIndex, setCurrentIndex])

  const goToIndex = useCallback(
    (index: number) => {
      if (index >= 0 && index < photos.length) {
        setCurrentIndex(index)
      }
    },
    [photos.length, setCurrentIndex],
  )

  return {
    isOpen,
    currentIndex,
    triggerElement,
    openViewer,
    closeViewer,
    goToNext,
    goToPrevious,
    goToIndex,
  }
}
